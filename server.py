import os
import io
import json
import base64
import logging
import sqlite3
import threading
import traceback

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pdfplumber

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('routeops')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
CORS(app)

# ── SQLite geocoding cache ──────────────────────────────────────────────────────

DB_PATH = os.path.join(BASE_DIR, 'geocache.db')
_db_lock = threading.Lock()


def _db_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _db_lock:
        conn = _db_conn()
        conn.execute('''
            CREATE TABLE IF NOT EXISTS geocache (
                addr_key     TEXT PRIMARY KEY,
                original_addr TEXT NOT NULL,
                lat          REAL NOT NULL,
                lng          REAL NOT NULL,
                resolved_addr TEXT,
                hit_count    INTEGER DEFAULT 1,
                created_at   TEXT DEFAULT (CURRENT_TIMESTAMP),
                last_hit     TEXT DEFAULT (CURRENT_TIMESTAMP)
            )
        ''')
        conn.commit()
        conn.close()
    count = _db_count()
    log.info('GeocCache SQLite: %s (%d entradas)', DB_PATH, count)


def _db_count():
    try:
        conn = _db_conn()
        n = conn.execute('SELECT COUNT(*) FROM geocache').fetchone()[0]
        conn.close()
        return n
    except Exception:
        return 0


_init_db()

CLAUDE_MODEL = 'claude-sonnet-4-6'

ADDRESS_PROMPT = (
    'Extraé TODAS las direcciones de entrega. '
    'Devolvé SOLO JSON sin texto extra:\n'
    '{"stops":[{"name":"Nombre cliente","address":"Dirección completa, NNNN Ciudad, Provincia, Argentina"}]}\n'
    'IMPORTANTE sobre códigos postales de 4 dígitos:\n'
    '- Si el texto muestra "2173, CHABAS" o "2177, Bigand" (número antes de coma), '
    'ese número ES el código postal y la ciudad viene después. '
    'Formateá como: Calle N, 2173 CHABAS, Provincia, Argentina\n'
    '- Si no hay calle visible, usá: 2173 CHABAS, Santa Fe, Argentina\n'
    '- Si hay código postal en otro formato (CP2627, 2627), incluilo antes de la ciudad.\n'
    '- Si no hay código postal, igual incluí la ciudad.'
)

# Prompt especializado para hojas de ruta escaneadas con columnas Destinatario/Domicilio
SCANNED_PDF_PROMPT = (
    'Esta imagen es una página de una hoja de ruta de reparto.\n'
    'Tu tarea: extraer TODAS Y CADA UNA de las filas con datos de entrega, SIN EXCEPCIÓN.\n'
    '\n'
    'PASO 1 — Contá mentalmente cuántas filas de datos (no encabezados) hay en la tabla.\n'
    'PASO 2 — Extraé exactamente ese número de entradas. No omitás ninguna.\n'
    '\n'
    'Las columnas pueden llamarse:\n'
    '  • Destinatario / Cliente / Nombre / Receptor\n'
    '  • Domicilio / Dirección / Calle / Entrega\n'
    '  • Localidad / Ciudad / Partido / Zona / Barrio / CP / Código Postal\n'
    '\n'
    'Por cada fila con datos (aunque esté incompleta), generá una entrada:\n'
    '  - name: contenido de la columna Destinatario/Cliente/Nombre\n'
    '  - address: Calle Número, NNNN Localidad, Provincia, Argentina\n'
    '    donde NNNN es el código postal de 4 dígitos si está visible.\n'
    '    CRÍTICO: si la tabla muestra "2173, CHABAS" o "2177, Bigand" o "2630, Firmat"\n'
    '    (número de 4 dígitos antes de una coma seguido de ciudad), ese número ES el código postal.\n'
    '    Formateá como: Calle Número, 2173 CHABAS, Provincia, Argentina\n'
    '    Si no hay calle visible para esa fila: 2173 CHABAS, Provincia, Argentina\n'
    '    Si no hay código postal visible, omitilo: Calle Número, Localidad, Provincia, Argentina\n'
    '\n'
    'Reglas ESTRICTAS:\n'
    '- NUNCA omitás una fila que tenga al menos calle o destinatario.\n'
    '- Si una fila no tiene localidad, usá la localidad más repetida en la página.\n'
    '- Si hay código postal en la tabla (columna CP, columna Localidad o encabezado de sección), incluilo.\n'
    '- Si hay Piso/Depto/Unidad, incluilo en la dirección.\n'
    '- Si el número de calle no está claro, escribilo como aparece (aunque sea ilegible).\n'
    '- Omití SOLO filas completamente vacías y encabezados de columna.\n'
    '- Si la página no tiene datos de entrega: {"stops":[]}\n'
    '\n'
    'Devolvé SOLO este JSON, sin texto extra, sin markdown, sin explicaciones:\n'
    '{"stops":[{"name":"Nombre destinatario","address":"Calle Número, CPXXXX Localidad, Provincia, Argentina"}]}'
)


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _claude_client():
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return None
    import anthropic
    return anthropic.Anthropic(api_key=api_key)


def _parse_stops_from_text(client, text):
    """Call Claude to extract stops from plain text. Returns list or raises."""
    prompt = ADDRESS_PROMPT + '\n\n' + text
    log.info('Claude text — prompt %d chars', len(prompt))
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1500,
        messages=[{'role': 'user', 'content': prompt}],
    )
    raw = response.content[0].text.strip().replace('```json', '').replace('```', '').strip()
    log.info('Claude text — respuesta: %s', raw[:300])
    return json.loads(raw).get('stops', [])


def _pdf_to_page_images(pdf_bytes, max_pages=10):
    """Render PDF pages to PNG using PyMuPDF. Returns list of bytes or []."""
    try:
        import fitz  # pymupdf
    except ImportError:
        log.warning('PyMuPDF no instalado — no se pueden renderizar páginas como imágenes')
        return []

    doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    n = min(len(doc), max_pages)
    log.info('PyMuPDF: renderizando %d de %d páginas', n, len(doc))
    images = []
    for i in range(n):
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(3.0, 3.0))  # 3× para mejor OCR en tablas escaneadas
        images.append(pix.tobytes('png'))
        log.info('  Página %d: %dx%d px, %d bytes PNG', i + 1, pix.width, pix.height, len(images[-1]))
    doc.close()
    return images


def _parse_scanned_pdf_page_by_page(client, page_images):
    """Process each PDF page individually with Claude Vision. Combines and deduplicates results."""
    all_stops = []

    for i, img_bytes in enumerate(page_images):
        log.info('Vision — página %d/%d (%d bytes PNG)', i + 1, len(page_images), len(img_bytes))
        b64 = base64.standard_b64encode(img_bytes).decode('utf-8')

        try:
            response = client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=4096,
                messages=[{
                    'role': 'user',
                    'content': [
                        {
                            'type': 'image',
                            'source': {'type': 'base64', 'media_type': 'image/png', 'data': b64},
                        },
                        {'type': 'text', 'text': SCANNED_PDF_PROMPT},
                    ],
                }],
            )
            raw = response.content[0].text.strip().replace('```json', '').replace('```', '').strip()
            log.info('  Página %d respuesta: %s', i + 1, raw[:300])
            page_stops = json.loads(raw).get('stops', [])
            log.info('  Página %d: %d parada(s) encontrada(s)', i + 1, len(page_stops))
            all_stops.extend(page_stops)
        except json.JSONDecodeError as e:
            log.error('  Página %d: JSON inválido — %s', i + 1, e)
        except Exception as e:
            log.error('  Página %d: error — %s\n%s', i + 1, e, traceback.format_exc())

    # Deduplicate by name+address (allows same address with different names)
    seen = set()
    unique = []
    for s in all_stops:
        if not s.get('name') and not s.get('address'):
            continue
        key = ((s.get('name') or '') + '|' + (s.get('address') or '')).lower().strip()
        if key not in seen:
            seen.add(key)
            unique.append(s)

    log.info('Vision total: %d paradas únicas (de %d en %d páginas)',
             len(unique), len(all_stops), len(page_images))
    return unique


# ── PDF extraction ─────────────────────────────────────────────────────────────

@app.route('/api/extract-pdf', methods=['POST'])
def extract_pdf():
    if 'pdf' not in request.files:
        log.warning('extract-pdf: campo "pdf" ausente')
        return jsonify({'error': 'Falta el archivo PDF (campo "pdf")'}), 400

    file = request.files['pdf']
    pdf_bytes = file.read()
    log.info('PDF recibido — name=%r size=%d bytes content_type=%r',
             file.filename, len(pdf_bytes), file.content_type)

    if len(pdf_bytes) == 0:
        log.error('PDF vacío recibido')
        return jsonify({'error': 'El archivo PDF está vacío'}), 400

    # ── 1. Extraer texto con pdfplumber ───────────────────────────────────────
    text = ''
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            total_pages = len(pdf.pages)
            log.info('pdfplumber: %d página(s) detectadas', total_pages)

            for i, page in enumerate(pdf.pages):
                try:
                    page_text = page.extract_text() or ''
                    char_count = len(page_text.strip())
                    log.info('  Página %d/%d: %d chars extraídos', i + 1, total_pages, char_count)
                    if page_text.strip():
                        text += page_text + '\n'
                except Exception as page_err:
                    tb = traceback.format_exc()
                    log.error('  Página %d/%d falló: %s\n%s', i + 1, total_pages, page_err, tb)

    except Exception as e:
        tb = traceback.format_exc()
        log.error('pdfplumber crash: %s\n%s', e, tb)
        return jsonify({
            'error': f'No se pudo abrir el PDF: {str(e)}',
            'exception_type': type(e).__name__,
            'traceback': tb,
        }), 500

    text_len = len(text.strip())
    log.info('pdfplumber resultado: %d chars totales', text_len)

    client = _claude_client()
    log.info('ANTHROPIC_API_KEY: %s', 'configurada' if client else 'NO configurada')

    # ── 2. PRIMARY: Vision página a página (siempre, cuando PyMuPDF disponible) ─
    if client:
        page_images = _pdf_to_page_images(pdf_bytes)
        if page_images:
            try:
                stops = _parse_scanned_pdf_page_by_page(client, page_images)
            except Exception as e:
                tb = traceback.format_exc()
                log.error('Vision falló: %s\n%s', e, tb)
                if text_len < 50:
                    return jsonify({
                        'error': f'Error procesando PDF con Vision: {str(e)}',
                        'exception_type': type(e).__name__,
                        'traceback': tb,
                    }), 500
                stops = []

            if stops:
                log.info('Vision OK: %d paradas en %d páginas', len(stops), len(page_images))
                return jsonify({'stops': stops, 'scanned': True, 'pages_processed': len(page_images)})

            if text_len < 50:
                log.warning('Vision procesó %d páginas sin encontrar paradas (sin texto de respaldo)', len(page_images))
                return jsonify({
                    'error': (
                        f'Claude Vision analizó {len(page_images)} página(s) pero no encontró direcciones. '
                        'Verificá que el PDF tenga columnas Destinatario/Domicilio visibles.'
                    )
                }), 422
            log.warning('Vision procesó %d páginas sin encontrar paradas — reintentando con texto', len(page_images))
        elif text_len < 50:
            return jsonify({
                'error': 'PDF escaneado sin texto. Instalá pymupdf en el servidor (pip install pymupdf) para activar OCR.'
            }), 400
    elif text_len < 50:
        log.warning('Vision imposible: sin ANTHROPIC_API_KEY')
        return jsonify({
            'error': 'PDF escaneado detectado. Configurá ANTHROPIC_API_KEY en Ajustes para procesar este tipo de PDF.'
        }), 503

    # ── 3. Fallback: parsear texto con Claude ──────────────────────────────────
    if client:
        try:
            stops = _parse_stops_from_text(client, text)
            log.info('Claude text OK: %d paradas', len(stops))
            if stops:
                return jsonify({'stops': stops, 'text': text})
            log.warning('Claude devolvió 0 paradas — devolviendo texto crudo')
        except json.JSONDecodeError as e:
            log.error('Claude text: JSON inválido — %s', e)
        except Exception as e:
            log.error('Claude text falló: %s\n%s', e, traceback.format_exc())

    log.info('Devolviendo texto crudo (%d chars) para parseo en cliente', text_len)
    return jsonify({'text': text, 'stops': []})


# ── Address extraction from plain text ────────────────────────────────────────

@app.route('/api/extract-addresses', methods=['POST'])
def extract_addresses():
    body = request.get_json(silent=True) or {}
    text = body.get('text', '').strip()
    log.info('extract-addresses: %d chars de texto', len(text))

    if not text:
        return jsonify({'error': 'Falta el campo "text"'}), 400

    client = _claude_client()
    if client:
        try:
            stops = _parse_stops_from_text(client, text)
            log.info('extract-addresses OK: %d paradas', len(stops))
            if stops:
                return jsonify({'stops': stops})
        except Exception as e:
            log.error('extract-addresses falló: %s', e)

    return jsonify({'text': text, 'stops': []})


# ── Image OCR via Claude Vision ────────────────────────────────────────────────

@app.route('/api/extract-image', methods=['POST'])
def extract_image():
    if 'image' not in request.files:
        return jsonify({'error': 'Falta el archivo de imagen (campo "image")'}), 400

    file = request.files['image']
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        return jsonify({'error': 'ANTHROPIC_API_KEY no configurada en el servidor'}), 503

    import mimetypes
    allowed = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
    media_type = file.content_type or ''
    if media_type not in allowed and file.filename:
        media_type = mimetypes.guess_type(file.filename)[0] or ''
    if media_type not in allowed:
        media_type = 'image/jpeg'

    img_bytes = file.read()
    log.info('extract-image: name=%r size=%d media_type=%r', file.filename, len(img_bytes), media_type)

    image_data = base64.standard_b64encode(img_bytes).decode('utf-8')

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2000,
            messages=[{
                'role': 'user',
                'content': [
                    {'type': 'image', 'source': {'type': 'base64', 'media_type': media_type, 'data': image_data}},
                    {'type': 'text', 'text': (
                        'Extraé TODAS las direcciones de entrega visibles en esta imagen. '
                        'Devolvé SOLO JSON sin texto extra:\n'
                        '{"stops":[{"name":"Nombre o descripción del destinatario","address":"Dirección completa, Ciudad, Provincia, Argentina"}]}\n'
                        'Si no aparece ciudad, inferí la más mencionada en la imagen.\n'
                        'Si la imagen es ilegible o no hay direcciones: {"stops":[]}'
                    )},
                ],
            }],
        )
        raw = response.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        log.info('extract-image OK: %s', raw[:200])
        return jsonify({'stops': json.loads(raw).get('stops', [])})
    except json.JSONDecodeError as e:
        log.error('extract-image: JSON inválido — %s', e)
        return jsonify({'error': 'Claude no devolvió JSON válido'}), 500
    except Exception as e:
        log.error('extract-image falló: %s\n%s', e, traceback.format_exc())
        return jsonify({'error': str(e)}), 500


# ── PDF diagnostic ────────────────────────────────────────────────────────────

def _make_minimal_pdf():
    """Build a valid single-page PDF with extractable text, computing xref offsets dynamically."""
    stream = b"BT /F1 12 Tf 72 720 Td (Test RouteOps Rivadavia 600) Tj ET\n"

    raw_objects = {
        1: b"<</Type/Catalog/Pages 2 0 R>>",
        2: b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        3: b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        4: b"<</Length " + str(len(stream)).encode() + b">>\nstream\n" + stream + b"endstream",
        5: b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    }

    body = b"%PDF-1.4\n"
    offsets = {}
    for n in sorted(raw_objects):
        offsets[n] = len(body)
        body += f"{n} 0 obj\n".encode() + raw_objects[n] + b"\nendobj\n"

    xref_pos = len(body)
    count = max(raw_objects) + 1
    xref = f"xref\n0 {count}\n0000000000 65535 f \n".encode()
    for i in range(1, count):
        xref += f"{offsets[i]:010d} 00000 n \n".encode()

    trailer = f"trailer\n<</Size {count}/Root 1 0 R>>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return body + xref + trailer


@app.route('/api/test-pdf')
def test_pdf():
    """Diagnostic endpoint — verifies pdfplumber is working end-to-end."""
    results = []

    # 1. Import check
    try:
        ver = pdfplumber.__version__
        results.append({'test': 'pdfplumber_import', 'status': 'ok', 'version': ver})
        log.info('test-pdf: pdfplumber v%s', ver)
    except Exception as e:
        results.append({'test': 'pdfplumber_import', 'status': 'fail',
                        'error': str(e), 'traceback': traceback.format_exc()})
        return jsonify({'results': results}), 500

    # 2. Generate minimal PDF and try to open it
    try:
        pdf_bytes = _make_minimal_pdf()
        results.append({'test': 'generate_pdf', 'status': 'ok', 'size_bytes': len(pdf_bytes)})
        log.info('test-pdf: PDF minimal generado (%d bytes)', len(pdf_bytes))
    except Exception as e:
        results.append({'test': 'generate_pdf', 'status': 'fail',
                        'error': str(e), 'traceback': traceback.format_exc()})
        return jsonify({'results': results}), 500

    # 3. Open with pdfplumber and extract text
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages = len(pdf.pages)
            text = pdf.pages[0].extract_text() or ''
        results.append({
            'test': 'extract_text', 'status': 'ok',
            'pages': pages, 'extracted_text': text,
        })
        log.info('test-pdf: extract_text OK — %r', text)
    except Exception as e:
        tb = traceback.format_exc()
        log.error('test-pdf: extract_text FAIL — %s\n%s', e, tb)
        results.append({'test': 'extract_text', 'status': 'fail',
                        'error': str(e), 'exception_type': type(e).__name__,
                        'traceback': tb})
        return jsonify({'results': results}), 500

    # 4. PyMuPDF check (optional)
    try:
        import fitz
        results.append({'test': 'pymupdf_import', 'status': 'ok', 'version': fitz.version[0]})
    except ImportError:
        results.append({'test': 'pymupdf_import', 'status': 'not_installed',
                        'note': 'Necesario solo para PDFs escaneados'})

    return jsonify({'results': results, 'overall': 'ok'})


# ── Audio transcription (Whisper via OpenAI) ──────────────────────────────────

@app.route('/api/transcribe', methods=['POST'])
def transcribe_audio():
    if 'audio' not in request.files:
        return jsonify({'error': 'Falta el archivo de audio (campo "audio")'}), 400

    openai_key = os.environ.get('OPENAI_API_KEY')
    if not openai_key:
        return jsonify({'error': 'Transcripción no disponible. Configurá OPENAI_API_KEY en el servidor.'}), 503

    file = request.files['audio']
    audio_bytes = file.read()
    filename = file.filename or 'recording.webm'
    log.info('transcribe: name=%r size=%d bytes', filename, len(audio_bytes))

    if len(audio_bytes) < 1000:
        return jsonify({'error': 'El audio es demasiado corto o está vacío'}), 400

    try:
        from openai import OpenAI
        oa = OpenAI(api_key=openai_key)
        audio_io = io.BytesIO(audio_bytes)
        audio_io.name = filename
        result = oa.audio.transcriptions.create(
            model='whisper-1',
            file=audio_io,
            language='es',
            prompt='Hoja de ruta de reparto con direcciones en Argentina. Localidades como Venado Tuerto, Rosario, Santa Fe.',
        )
        text = (result.text or '').strip()
        log.info('transcribe OK: %d chars — %s', len(text), text[:120])
        return jsonify({'text': text})
    except Exception as e:
        log.error('transcribe falló: %s\n%s', e, traceback.format_exc())
        return jsonify({'error': str(e)}), 500


# ── Geocoding cache (SQLite) ───────────────────────────────────────────────────

@app.route('/api/geocode/cache', methods=['GET'])
def geocache_lookup():
    addr = request.args.get('addr', '').strip()
    if not addr:
        return jsonify({'found': False}), 400
    key = addr.lower().strip()
    with _db_lock:
        conn = _db_conn()
        row = conn.execute(
            'SELECT lat, lng, resolved_addr FROM geocache WHERE addr_key = ?', (key,)
        ).fetchone()
        if row:
            conn.execute(
                'UPDATE geocache SET hit_count = hit_count + 1, last_hit = CURRENT_TIMESTAMP WHERE addr_key = ?',
                (key,)
            )
            conn.commit()
        conn.close()
    if row:
        log.info('GeocCache HIT: %s → %.6f,%.6f', addr[:60], row['lat'], row['lng'])
        return jsonify({'found': True, 'lat': row['lat'], 'lng': row['lng'],
                        'resolvedAddress': row['resolved_addr']})
    return jsonify({'found': False})


@app.route('/api/geocode/cache', methods=['POST'])
def geocache_save():
    data = request.get_json(silent=True) or {}
    addr = (data.get('addr') or '').strip()
    lat = data.get('lat')
    lng = data.get('lng')
    resolved = (data.get('resolvedAddress') or addr).strip()
    if not addr or lat is None or lng is None:
        return jsonify({'saved': False, 'error': 'Faltan campos addr/lat/lng'}), 400
    key = addr.lower().strip()
    with _db_lock:
        conn = _db_conn()
        conn.execute('''
            INSERT INTO geocache (addr_key, original_addr, lat, lng, resolved_addr)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(addr_key) DO UPDATE SET
                lat = excluded.lat, lng = excluded.lng,
                resolved_addr = excluded.resolved_addr,
                hit_count = hit_count + 1,
                last_hit = CURRENT_TIMESTAMP
        ''', (key, addr, float(lat), float(lng), resolved))
        conn.commit()
        conn.close()
    log.info('GeocCache SAVE: %s → %.6f,%.6f', addr[:60], float(lat), float(lng))
    return jsonify({'saved': True})


@app.route('/api/geocode/cache/stats', methods=['GET'])
def geocache_stats():
    with _db_lock:
        conn = _db_conn()
        total = conn.execute('SELECT COUNT(*) FROM geocache').fetchone()[0]
        top = conn.execute(
            'SELECT original_addr, hit_count FROM geocache ORDER BY hit_count DESC LIMIT 10'
        ).fetchall()
        conn.close()
    return jsonify({'total': total, 'top': [{'addr': r[0], 'hits': r[1]} for r in top]})


# ── Health check ───────────────────────────────────────────────────────────────

@app.route('/api/health')
def health():
    has_key = bool(os.environ.get('ANTHROPIC_API_KEY'))
    try:
        import fitz
        has_pymupdf = True
        pymupdf_ver = fitz.version[0]
    except ImportError:
        has_pymupdf = False
        pymupdf_ver = None
    return jsonify({
        'status': 'ok',
        'claude': has_key,
        'pymupdf': has_pymupdf,
        'pymupdf_version': pymupdf_ver,
    })


@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(BASE_DIR, filename)


if __name__ == '__main__':
    _init_db()
    port = int(os.environ.get('PORT', 5000))
    log.info('RouteOps arrancando en http://0.0.0.0:%d', port)
    log.info('Claude IA: %s', 'activo' if os.environ.get('ANTHROPIC_API_KEY') else 'NO configurado')
    try:
        import fitz
        log.info('PyMuPDF: instalado v%s — soporte PDFs escaneados activo', fitz.version[0])
    except ImportError:
        log.warning('PyMuPDF: NO instalado — PDFs escaneados no tendrán OCR fallback')
    app.run(host='0.0.0.0', port=port, debug=False)
