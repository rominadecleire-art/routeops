import os
import io
import json
import base64
import logging
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

CLAUDE_MODEL = 'claude-sonnet-4-6'
ADDRESS_PROMPT = (
    'Extraé TODAS las direcciones de entrega. '
    'Devolvé SOLO JSON sin texto extra:\n'
    '{"stops":[{"name":"Nombre cliente","address":"Dirección completa, Ciudad, Provincia, Argentina"}]}\n'
    'Si no tiene ciudad, usá "Venado Tuerto, Santa Fe, Argentina".'
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
        pix = doc[i].get_pixmap(matrix=fitz.Matrix(2.0, 2.0))  # 2× para mejor OCR
        images.append(pix.tobytes('png'))
        log.info('  Página %d: %dx%d px, %d bytes PNG', i + 1, pix.width, pix.height, len(images[-1]))
    doc.close()
    return images


def _parse_stops_from_images(client, page_images):
    """Call Claude Vision with rendered PDF page images. Returns list or raises."""
    log.info('Claude Vision — enviando %d imagen(es)', len(page_images))
    content = []
    for i, img_bytes in enumerate(page_images):
        b64 = base64.standard_b64encode(img_bytes).decode('utf-8')
        content.append({
            'type': 'image',
            'source': {'type': 'base64', 'media_type': 'image/png', 'data': b64},
        })
        log.info('  Imagen %d: %d bytes base64', i + 1, len(b64))
    content.append({
        'type': 'text',
        'text': ADDRESS_PROMPT + '\nEsta es la hoja de ruta escaneada.',
    })
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        messages=[{'role': 'user', 'content': content}],
    )
    raw = response.content[0].text.strip().replace('```json', '').replace('```', '').strip()
    log.info('Claude Vision — respuesta: %s', raw[:300])
    return json.loads(raw).get('stops', [])


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

    # ── 2. Fallback Vision si el texto es insuficiente (PDF escaneado) ─────────
    if text_len < 50:
        log.info('Texto insuficiente (%d chars) — PDF probablemente escaneado, activando Vision', text_len)

        if not client:
            log.warning('Vision fallback imposible: sin ANTHROPIC_API_KEY')
            return jsonify({
                'error': 'PDF escaneado detectado. Configurá ANTHROPIC_API_KEY en Ajustes para procesar este tipo de PDF.'
            }), 503

        page_images = _pdf_to_page_images(pdf_bytes)
        if not page_images:
            return jsonify({
                'error': 'PDF escaneado sin texto. Instalá pymupdf en el servidor (pip install pymupdf) para activar OCR.'
            }), 400

        try:
            stops = _parse_stops_from_images(client, page_images)
            log.info('Vision fallback OK: %d paradas', len(stops))
            return jsonify({'stops': stops, 'scanned': True})
        except json.JSONDecodeError as e:
            tb = traceback.format_exc()
            log.error('Vision: JSON inválido — %s\n%s', e, tb)
            return jsonify({
                'error': 'Claude Vision no devolvió JSON válido',
                'exception_type': 'JSONDecodeError',
                'traceback': tb,
            }), 500
        except Exception as e:
            tb = traceback.format_exc()
            log.error('Vision fallback falló: %s\n%s', e, tb)
            return jsonify({
                'error': f'Error en Vision fallback: {str(e)}',
                'exception_type': type(e).__name__,
                'traceback': tb,
            }), 500

    # ── 3. Parsear texto con Claude ────────────────────────────────────────────
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
    port = int(os.environ.get('PORT', 5000))
    log.info('RouteOps arrancando en http://0.0.0.0:%d', port)
    log.info('Claude IA: %s', 'activo' if os.environ.get('ANTHROPIC_API_KEY') else 'NO configurado')
    try:
        import fitz
        log.info('PyMuPDF: instalado v%s — soporte PDFs escaneados activo', fitz.version[0])
    except ImportError:
        log.warning('PyMuPDF: NO instalado — PDFs escaneados no tendrán OCR fallback')
    app.run(host='0.0.0.0', port=port, debug=False)
