import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError
import httpx
import bleach
from gtts import gTTS
import io

# Configuración básica
app = Flask(__name__)
load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar temas.json
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except Exception as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {}

# Inicializar base de datos
def init_db():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', avatar_id TEXT DEFAULT 'default')''')
        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, video_url TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT, animation_url TEXT)''')
        c.execute("INSERT INTO avatars (avatar_id, nombre, url, animation_url) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png", ""))
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        conn.commit()
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    return True

# Cache para progreso
def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        if row:
            return {"puntos": row[0], "temas_aprendidos": row[1], "avatar_id": row[2]}
        return {"puntos": 0, "temas_aprendidos": "", "avatar_id": "default"}
    except PsycopgError as e:
        logging.error(f"Error al cargar progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, avatar_id="default"):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, avatar_id) VALUES (%s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, avatar_id, puntos, temas_aprendidos, avatar_id))
        conn.commit()
        conn.close()
        logging.info(f"Progreso guardado para usuario {usuario}: puntos={puntos}, temas={temas_aprendidos}")
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

def buscar_respuesta_app(pregunta, usuario):
    logging.info(f"Procesando pregunta: {pregunta} (usuario: {usuario})")
    try:
        client = Groq(api_key=os.getenv("GROQ_API_KEY"), timeout=httpx.Timeout(30.0))
        completion = client.chat.completions.create(
            model="llama3-70b-8192",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Eres un asistente experto en programación avanzada para estudiantes de Telemática. "
                        "Responde en español con explicaciones claras, concisas y educativas, incluyendo ejemplos de código en Java o Python. "
                        "Enfócate en temas como POO, UML, MVC, patrones de diseño, bases de datos relacionales, ORM, y pruebas unitarias. "
                        "Si la pregunta es ambigua, pide aclaraciones. Si es un saludo, responde amigablemente y sugiere un tema. "
                        f"Contexto: {json.dumps(temas)}"
                    )
                },
                {"role": "user", "content": pregunta}
            ],
            max_tokens=500,
            temperature=0.5
        )
        respuesta = completion.choices[0].message.content.strip()
        logging.info(f"Respuesta de Groq: {respuesta}")
        return respuesta
    except Exception as e:
        logging.error(f"Error en Groq: {str(e)}")
        return "Lo siento, hubo un error al procesar tu pregunta. Intenta de nuevo."

# Rutas
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/respuesta", methods=["POST"])
def respuesta():
    try:
        data = request.get_json()
        if not data or "pregunta" not in data:
            logging.error("Solicitud inválida: falta pregunta")
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        pregunta = bleach.clean(data.get("pregunta").strip()[:300])
        avatar_id = bleach.clean(data.get("avatar_id", "default")[:50])

        if not pregunta:
            logging.error("Pregunta vacía recibida")
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        respuesta_text = buscar_respuesta_app(pregunta, usuario)
        avatar = None
        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"))
            c = conn.cursor()
            c.execute("SELECT url, animation_url FROM avatars WHERE avatar_id = %s", (avatar_id,))
            avatar = c.fetchone()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al consultar tabla avatars: {str(e)}")

        try:
            conn = psycopg2.connect(os.getenv("DATABASE_URL"))
            c = conn.cursor()
            c.execute("INSERT INTO logs (usuario, pregunta, respuesta, video_url) VALUES (%s, %s, %s, %s)",
                      (usuario, pregunta, respuesta_text, avatar[1] if avatar else ""))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar en logs: {str(e)}")

        response_data = {
            "respuesta": respuesta_text,
            "avatar_url": avatar[0] if avatar else "/static/img/default-avatar.png",
            "animation_url": avatar[1] if avatar else ""
        }
        logging.info(f"Respuesta enviada: {response_data}")
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"Error en /respuesta: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/progreso", methods=["GET"])
def progreso():
    usuario = request.args.get("usuario", "anonimo")
    progreso = cargar_progreso(usuario)
    logging.info(f"Progreso devuelto para usuario {usuario}: {progreso}")
    return jsonify(progreso)

@app.route("/avatars", methods=["GET"])
def avatars():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        avatars = [{"avatar_id": row[0], "nombre": row[1], "url": row[2], "animation_url": row[3]} for row in c.fetchall()]
        conn.close()
        logging.info(f"Avatares devueltos: {avatars}")
        return jsonify(avatars)
    except PsycopgError as e:
        logging.error(f"Error al consultar avatares: {str(e)}")
        return jsonify({"error": "Error al cargar avatares"}), 500

@app.route("/quiz", methods=["GET"])
def quiz():
    usuario = request.args.get("usuario", "anonimo")
    temas_disponibles = list(temas.keys())
    tema = random.choice(temas_disponibles)
    nivel = random.choice(["basico", "intermedio", "avanzado"])
    pregunta = f"¿Qué es {tema} ({nivel}) en el contexto de programación avanzada?"
    opciones = [temas[tema][nivel]]
    for _ in range(3):
        otro_tema = random.choice(temas_disponibles)
        otro_nivel = random.choice(["basico", "intermedio", "avanzado"])
        while otro_tema == tema and otro_nivel == nivel:
            otro_tema = random.choice(temas_disponibles)
            otro_nivel = random.choice(["basico", "intermedio", "avanzado"])
        opciones.append(temas[otro_tema][otro_nivel])
    random.shuffle(opciones)
    response_data = {
        "tema": tema,
        "nivel": nivel,
        "pregunta": pregunta,
        "opciones": opciones,
        "respuesta_correcta": temas[tema][nivel]
    }
    logging.info(f"Quiz generado: {response_data}")
    return jsonify(response_data)

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        respuesta = bleach.clean(data.get("respuesta", "")[:300])
        respuesta_correcta = bleach.clean(data.get("respuesta_correcta", "")[:300])
        tema = bleach.clean(data.get("tema", "")[:50])
        
        progreso = cargar_progreso(usuario)
        puntos = progreso["puntos"]
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        
        if respuesta == respuesta_correcta:
            puntos += 10
            if tema not in temas_aprendidos:
                temas_aprendidos.append(tema)
            mensaje = f"¡Correcto! Has ganado 10 puntos. Tema: {tema}"
        else:
            mensaje = f"Incorrecto. La respuesta correcta era: {respuesta_correcta}"
        
        guardar_progreso(usuario, puntos, ",".join(temas_aprendidos))
        logging.info(f"Quiz respondido por {usuario}: {mensaje}")
        return jsonify({"respuesta": mensaje})
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error al responder quiz: {str(e)}"}), 500

@app.route("/tts", methods=["POST"])
def tts():
    try:
        data = request.get_json()
        text = bleach.clean(data.get("text", "")[:1000])
        if not text:
            logging.error("Texto vacío en /tts")
            return jsonify({"error": "El texto no puede estar vacío"}), 400
        tts = gTTS(text=text, lang='es')
        audio_io = io.BytesIO()
        tts.write_to_fp(audio_io)
        audio_io.seek(0)
        return send_file(audio_io, mimetype='audio/mp3')
    except Exception as e:
        logging.error(f"Error en /tts: {str(e)}")
        return jsonify({"error": f"Error al generar audio: {str(e)}"}), 500

@app.route("/recommend", methods=["GET"])
def recommend():
    usuario = request.args.get("usuario", "anonimo")
    progreso = cargar_progreso(usuario)
    temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
    temas_disponibles = list(temas.keys())
    temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
    recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)
    logging.info(f"Recomendación para {usuario}: {recomendacion}")
    return jsonify({"recomendacion": recomendacion})

if __name__ == "__main__":
    init_db()
    if os.getenv("RENDER", "false").lower() != "true":
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("0.0.0.0", 5000))
            sock.close()
            webbrowser.open("http://localhost:5000")
        except OSError:
            logging.warning("Puerto 5000 en uso.")
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 5000)))