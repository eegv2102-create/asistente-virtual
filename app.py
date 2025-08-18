from flask import Flask, request, jsonify, Response, send_from_directory
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import os
import logging
import psycopg2
import bleach
from dotenv import load_dotenv
from gtts import gTTS
from io import BytesIO
from groq import Groq

app = Flask(__name__, static_folder='static', static_url_path='/static')
load_dotenv()

# Initialize Flask-Limiter with corrected syntax
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per day", "50 per hour"]
)

GROQ_API_KEY = os.getenv('GROQ_API_KEY')
if not GROQ_API_KEY:
    logging.error("GROQ_API_KEY not found in environment variables")
client = Groq(api_key=GROQ_API_KEY)

logging.basicConfig(level=logging.INFO)

def get_groq_response(prompt, max_tokens=200):
    try:
        response = client.chat.completions.create(
            model="llama3-8b-8192",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            stream=True
        )
        return response
    except Exception as e:
        logging.error(f'Error al contactar con Groq API: {str(e)}')
        return None

@app.route('/')
def serve_index():
    logging.info("Serving index.html")
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/static/<path:path>')
def serve_static(path):
    try:
        logging.info(f"Serving static file: {path}")
        return send_from_directory(app.static_folder, path)
    except Exception as e:
        logging.error(f'Error al servir archivo estático {path}: {str(e)}')
        return jsonify({'error': f'Archivo no encontrado: {path}'}), 404

@app.route('/respuesta', methods=['POST'])
@limiter.limit("10 per minute")
def respuesta():
    try:
        data = request.get_json()
        pregunta = bleach.clean(data.get('pregunta', '')[:1000])
        usuario = bleach.clean(data.get('usuario', 'anonimo')[:50])
        avatar_id = bleach.clean(data.get('avatar_id', 'default')[:50])
        max_length = data.get('max_length', 200)

        if not pregunta:
            return jsonify({'error': 'Pregunta vacía'}), 400

        prompt = f"""Actúa como un tutor educativo especializado en el tema de la pregunta. Proporciona una respuesta clara y concisa con un ejemplo relevante. Si la pregunta incluye "ejercicio" o "ejercicios", genera un ejercicio relacionado con el tema. Si incluye "sugiere un tema" o "recomendar tema", sugiere un tema relacionado. Finaliza con: "¿Entendiste? Si necesitas que lo explique de otra manera, házmelo saber." Responde en español, máximo {max_length} tokens. Pregunta: {pregunta}"""
        response = get_groq_response(prompt, max_length)
        if not response:
            return jsonify({'error': 'Error al contactar con el modelo'}), 500

        def generate():
            for chunk in response:
                content = chunk.choices[0].delta.content or ''
                if content:
                    yield content

        conn = psycopg2.connect(os.getenv('DATABASE_URL'))
        c = conn.cursor()
        c.execute('INSERT INTO logs (usuario, pregunta, respuesta, avatar_id, timestamp) VALUES (%s, %s, %s, %s, NOW())',
                  (usuario, pregunta, '', avatar_id))
        conn.commit()
        conn.close()

        return Response(generate(), content_type='text/event-stream')

    except Exception as e:
        logging.error(f'Error en /respuesta: {str(e)}')
        return jsonify({'error': f'Error al procesar la pregunta: {str(e)}'}), 500

@app.route('/quiz', methods=['GET'])
@limiter.limit("5 per minute")
def quiz():
    try:
        usuario = bleach.clean(request.args.get('usuario', 'anonimo')[:50])
        prompt = """Genera un quiz educativo en español con una pregunta, cuatro opciones de respuesta (una correcta), y el tema asociado. Formato JSON: {"pregunta": "", "opciones": [], "respuesta_correcta": "", "tema": ""}."""
        response = get_groq_response(prompt, 200)
        if not response:
            return jsonify({'error': 'Error al contactar con el modelo'}), 500
        full_response = ''
        for chunk in response:
            content = chunk.choices[0].delta.content or ''
            if content:
                full_response += content
        import json
        quiz_data = json.loads(full_response.strip())
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f'Error en /quiz: {str(e)}')
        return jsonify({'error': f'Error al generar quiz: {str(e)}'}), 500

@app.route('/responder_quiz', methods=['POST'])
@limiter.limit("10 per minute")
def responder_quiz():
    try:
        data = request.get_json()
        respuesta = bleach.clean(data.get('respuesta', '')[:500])
        respuesta_correcta = bleach.clean(data.get('respuesta_correcta', '')[:500])
        tema = bleach.clean(data.get('tema', '')[:100])
        usuario = bleach.clean(data.get('usuario', 'anonimo')[:50])

        es_correcta = respuesta == respuesta_correcta
        prompt = f"""El usuario respondió un quiz sobre {tema}. Respuesta dada: {respuesta}. Respuesta correcta: {respuesta_correcta}. Proporciona una explicación de por qué es {'' if es_correcta else 'in'}correcta, incluyendo un ejemplo. Finaliza con: "¿Entendiste? Si necesitas que lo explique de otra manera, házmelo saber." Responde en español, máximo 200 tokens."""
        response = get_groq_response(prompt, 200)
        if not response:
            return jsonify({'error': 'Error al contactar con el modelo'}), 500
        full_response = ''
        for chunk in response:
            content = chunk.choices[0].delta.content or ''
            if content:
                full_response += content
        return jsonify({'respuesta': full_response, 'es_correcta': es_correcta})
    except Exception as e:
        logging.error(f'Error en /responder_quiz: {str(e)}')
        return jsonify({'error': f'Error al procesar respuesta: {str(e)}'}), 500

@app.route('/recomendacion', methods=['GET'])
@limiter.limit("5 per minute")
def recomendacion():
    try:
        usuario = bleach.clean(request.args.get('usuario', 'anonimo')[:50])
        prompt = """Sugiere un tema educativo en español para que el usuario estudie, con una breve descripción de por qué es útil. Formato JSON: {"recomendacion": "", "descripcion": ""}."""
        response = get_groq_response(prompt, 100)
        if not response:
            return jsonify({'error': 'Error al contactar con el modelo'}), 500
        full_response = ''
        for chunk in response:
            content = chunk.choices[0].delta.content or ''
            if content:
                full_response += content
        import json
        rec_data = json.loads(full_response.strip())
        return jsonify({'recomendacion': rec_data['recomendacion']})
    except Exception as e:
        logging.error(f'Error en /recomendacion: {str(e)}')
        return jsonify({'error': f'Error al recomendar tema: {str(e)}'}), 500

@app.route('/logs', methods=['GET'])
@limiter.limit("10 per minute")
def logs():
    try:
        usuario = bleach.clean(request.args.get('usuario', 'anonimo')[:50])
        conn = psycopg2.connect(os.getenv('DATABASE_URL'))
        c = conn.cursor()
        c.execute('SELECT pregunta, respuesta, timestamp FROM logs WHERE usuario = %s ORDER BY timestamp DESC', (usuario,))
        logs = [{'pregunta': row[0], 'respuesta': row[1], 'timestamp': row[2].isoformat()} for row in c.fetchall()]
        conn.close()
        return jsonify(logs)
    except Exception as e:
        logging.error(f'Error en /logs: {str(e)}')
        return jsonify({'error': f'Error al cargar logs: {str(e)}'}), 500

@app.route('/avatars', methods=['GET'])
@limiter.limit("10 per minute")
def avatars():
    try:
        avatars = [
            {'avatar_id': 'default', 'nombre': 'Default', 'url': '/static/img/default-avatar.png'},
            {'avatar_id': 'poo', 'nombre': 'POO', 'url': '/static/img/poo.png'}
        ]
        return jsonify(avatars)
    except Exception as e:
        logging.error(f'Error en /avatars: {str(e)}')
        return jsonify({'error': f'Error al cargar avatares: {str(e)}'}), 500

@app.route('/tts', methods=['POST'])
@limiter.limit("10 per minute")
def tts():
    try:
        data = request.get_json()
        text = bleach.clean(data.get('text', '')[:1000])
        if not text:
            return jsonify({'error': 'Texto vacío'}), 400
        tts = gTTS(text=text, lang='es')
        audio_io = BytesIO()
        tts.write_to_fp(audio_io)
        audio_io.seek(0)
        return Response(audio_io, mimetype='audio/mp3')
    except Exception as e:
        logging.error(f'Error en /tts: {str(e)}')
        return jsonify({'error': f'Error al generar TTS: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True)