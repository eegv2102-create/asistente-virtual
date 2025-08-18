import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory
from fuzzywuzzy import process
from functools import lru_cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from gtts import gTTS
import io
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError
import httpx
import bleach

# Cargar variables de entorno
load_dotenv()

app = Flask(__name__)

# Configuración de logging optimizada para Render
logging.basicConfig(
    filename='app.log',
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

# Funciones de respaldo para nlp.py
try:
    from nlp import buscar_respuesta, classify_intent, normalize
except ImportError as e:
    logging.error(f"No se pudo importar nlp.py: {str(e)}")
    def buscar_respuesta(pregunta, k=3):
        logging.warning("Usando buscar_respuesta de respaldo")
        return []
    def classify_intent(pregunta):
        logging.warning("Usando classify_intent de respaldo")
        if any(word in pregunta.lower() for word in ["hola", "saludos"]):
            return "saludo"
        if "quiz" in pregunta.lower():
            return "quiz"
        return "definicion"
    def normalize(pregunta):
        logging.warning("Usando normalize de respaldo")
        return pregunta.lower()

# Rate limiting ajustado para Render
limiter = Limiter(get_remote_address, app=app, default_limits=["10 per minute"])

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
                  ("default", "Avatar Predeterminado", "", ""))
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        conn.commit()
        conn.close()
        logging.info("Base de datos inicializada correctamente")
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        return False
    return True

# Cargar temas.json y prerequisitos.json
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {
        "poo": {"basico": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento."},
        "patrones de diseño": {"basico": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software."},
        "multihilos": {"basico": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento."},
        "mvc": {"basico": "El patrón MVC separa la lógica de negocio, la interfaz de usuario y el control en tres componentes interconectados."}
    }
    logging.warning("Usando temas por defecto")

try:
    with open("prerequisitos.json", "r", encoding="utf-8") as f:
        prerequisitos = json.load(f)
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando prerequisitos.json: {str(e)}")
    prerequisitos = {
        "herencia": ["poo", "clases y objetos"],
        "polimorfismo": ["poo", "clases y objetos", "herencia"],
        "singleton": ["poo", "clases y objetos"],
        "factory": ["poo", "clases y objetos"],
        "observer": ["poo", "clases y objetos"],
        "clases abstractas": ["poo", "clases y objetos", "herencia"],
        "interfaces": ["poo", "clases y objetos", "herencia", "polimorfismo"],
        "uml": ["poo", "clases y objetos"],
        "patrones de diseno": ["poo", "clases y objetos", "herencia", "polimorfismo"],
        "mvc": ["poo", "clases y objetos", "uml", "interfaces"],
        "archivos": ["poo", "clases y objetos"],
        "bases de datos": ["base de datos", "comandos sql ddl"],
        "pruebas": ["poo", "clases y objetos"],
        "comandos sql ddl": ["base de datos"],
        "comandos sql mdl": ["base de datos", "comandos sql ddl"]
    }
    logging.warning("Usando prerequisitos por defecto")

@lru_cache(maxsize=128)
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
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

def buscar_respuesta_app(pregunta, usuario):
    # Primero, busca en el conocimiento local
    results = buscar_respuesta(pregunta)
    if results:
        return results[0][1]  # Devuelve la mejor coincidencia local

    # Si no encuentra, usa Groq con Llama 3
    try:
        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        completion = client.chat.completions.create(
            model="llama3-8b-8192",  # O usa "llama3-70b-8192" para más precisión
            messages=[
                {"role": "system", "content": "Eres un asistente experto en programación avanzada. Usa este conocimiento base para responder: " + json.dumps(temas)},
                {"role": "user", "content": pregunta}
            ]
        )
        return completion.choices[0].message.content
    except Exception as e:
        logging.error(f"Error en Groq: {str(e)}")
        return "Lo siento, no pude generar una respuesta con la API de Groq."

# Ruta para favicon
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')

# Ruta principal
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/respuesta", methods=["POST"])
def respuesta():
    try:
        data = request.get_json()
        if not data or "pregunta" not in data:
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        pregunta = bleach.clean(data.get("pregunta").strip()[:300])
        avatar_id = bleach.clean(data.get("avatar_id", "default")[:50])
        if not pregunta:
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        progreso = cargar_progreso(usuario)
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
        
        response_data = {
            "respuesta": respuesta_text,
            "avatar_url": avatar[0] if avatar else "",
            "animation_url": avatar[1] if avatar else ""
        }
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"Error en /respuesta: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/progreso", methods=["GET"])
def progreso():
    usuario = request.args.get("usuario", "anonimo")
    progreso = cargar_progreso(usuario)
    return jsonify(progreso)

@app.route("/avatars", methods=["GET"])
def avatars():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        avatars = [{"avatar_id": row[0], "nombre": row[1], "url": row[2], "animation_url": row[3]} for row in c.fetchall()]
        conn.close()
        return jsonify(avatars)
    except PsycopgError as e:
        logging.error(f"Error al consultar avatares: {str(e)}")
        return jsonify({"error": "Error al cargar avatares"}), 500

@app.route("/quiz", methods=["GET"])
def quiz():
    usuario = request.args.get("usuario", "anonimo")
    temas_disponibles = list(temas.keys())
    tema = random.choice(temas_disponibles)
    nivel = request.args.get("nivel", "basico")
    pregunta = f"¿Qué es {tema} en el contexto de programación?"
    opciones = [temas[tema][nivel]]
    for _ in range(3):
        otro_tema = random.choice(temas_disponibles)
        while otro_tema == tema:
            otro_tema = random.choice(temas_disponibles)
        opciones.append(temas[otro_tema][nivel])
    random.shuffle(opciones)
    return jsonify({
        "tema": tema,
        "pregunta": pregunta,
        "opciones": opciones,
        "respuesta_correcta": temas[tema][nivel]
    })

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
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
    return jsonify({"respuesta": mensaje})

@app.route("/tts", methods=["POST"])
def tts():
    try:
        data = request.get_json()
        text = bleach.clean(data.get("text", "")[:1000])
        if not text:
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
    return jsonify({"recomendacion": recomendacion})

@app.route("/analytics", methods=["GET"])
def analytics():
    usuario = request.args.get("usuario", "anonimo")
    # Dummy data para evitar 404; expande con lógica real si necesitas
    data = [
        {"tema": "POO", "tasa_acierto": 0.8},
        {"tema": "MVC", "tasa_acierto": 0.6}
    ]
    return jsonify(data)

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