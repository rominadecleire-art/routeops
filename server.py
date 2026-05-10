import os
import json
import io

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pdfplumber

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
CORS(app)

# ── PDF extraction + optional Claude address parsing ──────────────────────────

@app.route('/api/extract-pdf', methods=['POST'])
def extract_pdf():
    if 'pdf' not in request.files:
        return jsonify({'error': 'Falta el archivo PDF (campo "pdf")'}), 400

    file = request.files['pdf']

    # Extract text with pdfplumber
    text = ''
    try:
        with pdfplumber.open(io.BytesIO(file.read())) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text += page_text + '\n'
    except Exception as e:
        return jsonify({'error': f'Error al leer el PDF: {str(e)}'}), 500

    if not text.strip():
        return jsonify({'error': 'El PDF no contiene texto extraíble (puede ser un PDF escaneado)'}), 400

    # If ANTHROPIC_API_KEY is set, parse addresses with Claude
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if api_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=api_key)
            prompt = (
                'Extraé TODAS las direcciones de entrega del texto. '
                'Devolvé SOLO JSON sin texto extra:\n'
                '{"stops":[{"name":"Nombre cliente","address":"Dirección completa, Ciudad, Provincia, Argentina"}]}\n'
                'Si no tiene ciudad, usá "Venado Tuerto, Santa Fe, Argentina".\n\n'
                + text
            )
            response = client.messages.create(
                model='claude-sonnet-4-6',
                max_tokens=1500,
                messages=[{'role': 'user', 'content': prompt}],
            )
            raw = response.content[0].text
            raw = raw.replace('```json', '').replace('```', '').strip()
            data = json.loads(raw)
            stops = data.get('stops', [])
            if stops:
                return jsonify({'stops': stops, 'text': text})
        except Exception:
            pass  # fall through and return raw text

    return jsonify({'text': text, 'stops': []})


# ── Address extraction from plain text ───────────────────────────────────────

@app.route('/api/extract-addresses', methods=['POST'])
def extract_addresses():
    body = request.get_json(silent=True) or {}
    text = body.get('text', '').strip()

    if not text:
        return jsonify({'error': 'Falta el campo "text"'}), 400

    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if api_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=api_key)
            prompt = (
                'Extraé TODAS las direcciones de entrega del texto. '
                'Devolvé SOLO JSON sin texto extra:\n'
                '{"stops":[{"name":"Nombre cliente","address":"Dirección completa, Ciudad, Provincia, Argentina"}]}\n'
                'Si no tiene ciudad, usá "Venado Tuerto, Santa Fe, Argentina".\n\n'
                + text
            )
            response = client.messages.create(
                model='claude-sonnet-4-6',
                max_tokens=1500,
                messages=[{'role': 'user', 'content': prompt}],
            )
            raw = response.content[0].text
            raw = raw.replace('```json', '').replace('```', '').strip()
            data = json.loads(raw)
            stops = data.get('stops', [])
            if stops:
                return jsonify({'stops': stops})
        except Exception:
            pass

    # Fallback: return raw text for client-side parsing
    return jsonify({'text': text, 'stops': []})


# ── Health check ──────────────────────────────────────────────────────────────

@app.route('/api/health')
def health():
    has_key = bool(os.environ.get('ANTHROPIC_API_KEY'))
    return jsonify({'status': 'ok', 'claude': has_key})


@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(BASE_DIR, filename)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f'RouteOps server arrancando en http://0.0.0.0:{port}')
    print('Claude IA:', 'activo' if os.environ.get('ANTHROPIC_API_KEY') else 'no configurado (solo pdfplumber)')
    app.run(host='0.0.0.0', port=port, debug=False)
