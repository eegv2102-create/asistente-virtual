import time
import json
import os
import random
import logging
import socket
from flask import Flask, render_template, request, jsonify
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

# Cargar variables de entorno
load_dotenv()

app = Flask(__name__)

# Configuración de logging
logging.basicConfig(
    filename='app.log',
    level=logging.DEBUG,  # Cambiado a DEBUG para mayor detalle
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
        if any(word in pregunta.lower() for word in ["nivel", "cambiar nivel"]):
            return "cambiar_nivel"
        if "quiz" in pregunta.lower():
            return "quiz"
        return "definicion"
    def normalize(pregunta):
        logging.warning("Usando normalize de respaldo")
        return pregunta.lower()

# Rate limiting
limiter = Limiter(get_remote_address, app=app, default_limits=["5 per minute"])

def init_db():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0, temas_aprendidos TEXT DEFAULT '', nivel TEXT DEFAULT 'intermedio', avatar_id TEXT DEFAULT 'default')''')
        c.execute('''CREATE TABLE IF NOT EXISTS aprendizaje
                     (pregunta TEXT PRIMARY KEY, respuesta TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY, usuario TEXT, pregunta TEXT, respuesta TEXT, video_url TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY, nombre TEXT, url TEXT)''')
        c.execute("INSERT INTO avatars (avatar_id, nombre, url) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png"))
        c.execute("INSERT INTO avatars (avatar_id, nombre, url) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                  ("poo", "POO Avatar", "/static/img/poo.png"))
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, timestamp)')
        c.execute('''CREATE TABLE IF NOT EXISTS progreso_tema
                     (usuario TEXT, tema TEXT, dominio REAL DEFAULT 0.0, aciertos INTEGER DEFAULT 0, fallos INTEGER DEFAULT 0, ultima_interaccion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                     PRIMARY KEY (usuario, tema))''')
        conn.commit()

        try:
            with open("aprendizaje_inicial.json", "r", encoding="utf-8") as f:
                aprendizaje_inicial = json.load(f)
            for pregunta, respuesta in aprendizaje_inicial.items():
                c.execute("INSERT INTO aprendizaje (pregunta, respuesta) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                          (pregunta.lower(), respuesta))
            conn.commit()
            logging.info("aprendizaje_inicial.json cargado correctamente")
        except FileNotFoundError:
            logging.warning("No se encontró aprendizaje_inicial.json, usando datos por defecto")
        except json.JSONDecodeError as e:
            logging.error(f"Error al parsear aprendizaje_inicial.json: {str(e)}")
        conn.close()
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        raise

# Cargar temas.json
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados correctamente: %s", list(temas.keys()))
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {
        "poo": "La programación orientada a objetos organiza el código en objetos que combinan datos y comportamiento.",
        "patrones de diseño": "Los patrones de diseño son soluciones reutilizables para problemas comunes en el diseño de software.",
        "multihilos": "El multihilo permite ejecutar tareas simultáneamente para mejorar el rendimiento."
    }
    logging.warning("Usando temas por defecto")

# Cargar prerequisitos.json
try:
    with open("prerequisitos.json", "r", encoding="utf-8") as f:
        prerequisitos = json.load(f)
except (FileNotFoundError, json.JSONDecodeError) as e:
    logging.error(f"Error cargando prerequisitos.json: {str(e)}")
    prerequisitos = {
        "patrones de diseño": ["poo"],
        "multihilos": ["poo"],
        "poo": [],
    }
    logging.warning("Usando prerequisitos por defecto")

@lru_cache(maxsize=128)
def cargar_aprendizaje():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT pregunta, respuesta FROM aprendizaje")
        aprendizaje = dict(c.fetchall())
        conn.close()
        logging.debug("Aprendizaje cargado desde la base de datos")
        return aprendizaje
    except PsycopgError as e:
        logging.error(f"Error al cargar aprendizaje: {str(e)}")
        return {}

@lru_cache(maxsize=128)
def cargar_progreso(usuario):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT puntos, temas_aprendidos, nivel, avatar_id FROM progreso WHERE usuario = %s", (usuario,))
        row = c.fetchone()
        conn.close()
        result = {"puntos": row[0] if row else 0, "temas_aprendidos": row[1] if row else "",
                  "nivel": row[2] if row else "intermedio", "avatar_id": row[3] if row else "default"}
        logging.debug(f"Progreso cargado para usuario {usuario}: {result}")
        return result
    except PsycopgError as e:
        logging.error(f"Error al cargar progreso: {str(e)}")
        return {"puntos": 0, "temas_aprendidos": "", "nivel": "intermedio", "avatar_id": "default"}

def guardar_progreso(usuario, puntos, temas_aprendidos, nivel="intermedio", avatar_id="default"):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, nivel, avatar_id) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, nivel = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, nivel, avatar_id, puntos, temas_aprendidos, nivel, avatar_id))
        conn.commit()
        conn.close()
        logging.debug(f"Progreso guardado para usuario {usuario}: puntos={puntos}, nivel={nivel}")
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

def log_interaccion(usuario, pregunta, respuesta, video_url=None):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO logs (usuario, pregunta, respuesta, video_url) VALUES (%s, %s, %s, %s)",
                  (usuario, pregunta, respuesta, video_url))
        conn.commit()
        conn.close()
        logging.debug(f"Interacción registrada: usuario={usuario}, pregunta={pregunta}")
    except PsycopgError as e:
        logging.error(f"Error al registrar log: {str(e)}")

FUZZY_THRESHOLD = 75
MAX_PREGUNTA_LEN = 500
MAX_RESPUESTA_LEN = 2000

SINONIMOS = {
    "patrones de diseño": ["design patterns", "patrones", "patrones diseño"],
    "multihilos": ["multithreading", "hilos", "threads"],
    "poo": ["programacion orientada a objetos", "oop", "orientada objetos"],
}

def expandir_pregunta(pregunta):
    palabras = pregunta.lower().split()
    expandida = []
    for palabra in palabras:
        for clave, sinonimos in SINONIMOS.items():
            if palabra in sinonimos:
                expandida.append(clave)
                break
        else:
            expandida.append(palabra)
    return " ".join(expandida)

def consultar_groq_api(pregunta, nivel):
    try:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            logging.error("GROQ_API_KEY no está configurado")
            return "Error: Falta la clave de API de Groq. Por favor, contacta al administrador."

        client = Groq(api_key=api_key)
        prompt = f"Eres un asistente de programación. Responde a la siguiente pregunta en un nivel {nivel}: {pregunta}"
        logging.debug(f"Enviando solicitud a Groq: modelo=llama3-8b-8192, prompt={prompt}")
        completion = client.chat.completions.create(
            model="llama3-8b-8192",
            messages=[
                {"role": "system", "content": "Eres un tutor de programación experto que adapta sus respuestas a los niveles básico, intermedio y avanzado."},
                {"role": "user", "content": prompt}
            ],
            temperature=1,
            max_tokens=MAX_RESPUESTA_LEN,
            top_p=1,
            stream=False,
            stop=None
        )
        respuesta_ia = completion.choices[0].message.content.strip()
        logging.debug(f"Respuesta de Groq recibida: {respuesta_ia[:100]}...")
        return respuesta_ia[:MAX_RESPUESTA_LEN] + ("..." if len(respuesta_ia) > MAX_RESPUESTA_LEN else "")
    except Exception as e:
        logging.error(f"Error al consultar la API de Groq: {str(e)}")
        return f"Error al consultar la API de Groq: {str(e)}"

def buscar_respuesta_app(pregunta, usuario):
    try:
        logging.debug(f"Procesando pregunta: {pregunta}, usuario: {usuario}")
        progreso = cargar_progreso(usuario)
        nivel = progreso["nivel"]
        intent = classify_intent(pregunta)
        aprendizaje = cargar_aprendizaje()

        if intent == "saludo":
            logging.debug("Intención detectada: saludo")
            return aprendizaje.get(pregunta.lower(), "Hola, ¿qué quieres aprender sobre programación avanzada?")
        elif intent == "cambiar_nivel":
            logging.debug("Intención detectada: cambiar_nivel")
            nuevo_nivel = "basico" if "basico" in pregunta else "intermedio" if "intermedio" in pregunta else "avanzado"
            guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nuevo_nivel, progreso["avatar_id"])
            return f"Nivel cambiado a {nuevo_nivel}. ¿Qué tema quieres explorar ahora?"
        elif intent == "quiz":
            logging.debug("Intención detectada: quiz")
            quiz_data = quiz().get_json()
            return quiz_data["pregunta"] + " Opciones: " + ", ".join(quiz_data["opciones"])

        expandida = expandir_pregunta(normalize(pregunta))
        logging.debug(f"Pregunta expandida: {expandida}")

        try:
            hits = buscar_respuesta(expandida, k=3)
            logging.debug(f"Resultados de buscar_respuesta: {hits}")
        except Exception as e:
            logging.error(f"Error en buscar_respuesta: {str(e)}")
            hits = []

        if hits and len(hits) > 0 and hits[0][2] > 0.5:
            tema, fragmento, _ = hits[0]
            logging.debug(f"Tema encontrado: {tema}, fragmento: {fragmento}")
            if prerequisitos.get(tema) and any(cargar_dominio(usuario, prereq) < 0.6 for prereq in prerequisitos[tema]):
                return f"Primero domina los prerequisitos: {', '.join(prerequisitos[tema])}. ¿Quieres empezar con ellos?"

            if nivel == "basico":
                respuesta = f"[Básico] {fragmento.split('.')[0]}. Analogía: Como un {tema} en la vida real. ¿Quieres un ejemplo simple o un quiz?"
            elif nivel == "intermedio":
                respuesta = f"[Intermedio] {fragmento}. Ejemplo práctico: class Ejemplo: ... ¿Quieres un ejercicio guiado?"
            else:
                respuesta = f"[Avanzado] {fragmento}. Pitfalls comunes: Sobrecarga. Referencia: docs.python.org. ¿Quieres un caso real o un quiz?"
            
            log_interaccion(usuario, pregunta, respuesta)
            actualizar_dominio(usuario, tema, 0.1)
            return respuesta

        match = process.extractOne(expandida, aprendizaje.keys())
        if match and match[1] >= FUZZY_THRESHOLD:
            logging.debug(f"Respuesta encontrada en aprendizaje: {match[0]}")
            return aprendizaje[match[0]]
        
        respuesta = consultar_groq_api(pregunta, nivel)
        log_interaccion(usuario, pregunta, respuesta)
        return respuesta + " ¿Quieres saber más o un quiz?"
        
    except Exception as e:
        logging.error(f"Error en buscar_respuesta_app: {str(e)}")
        return f"Error interno al procesar la pregunta: {str(e)}"

def actualizar_dominio(usuario, tema, delta):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO progreso_tema (usuario, tema, dominio, aciertos, fallos) VALUES (%s, %s, %s, %s, %s) "
                  "ON CONFLICT (usuario, tema) DO UPDATE SET dominio = GREATEST(progreso_tema.dominio + %s, 0), "
                  "aciertos = progreso_tema.aciertos + %s, fallos = progreso_tema.fallos + %s, "
                  "ultima_interaccion = CURRENT_TIMESTAMP",
                  (usuario, tema, delta, 1 if delta > 0 else 0, 1 if delta < 0 else 0, delta, 1 if delta > 0 else 0, 1 if delta < 0 else 0))
        conn.commit()
        conn.close()
        logging.debug(f"Dominio actualizado: usuario={usuario}, tema={tema}, delta={delta}")
    except PsycopgError as e:
        logging.error(f"Error al actualizar dominio: {str(e)}")

def cargar_dominio(usuario, tema):
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT dominio FROM progreso_tema WHERE usuario = %s AND tema = %s", (usuario, tema))
        row = c.fetchone()
        conn.close()
        return row[0] if row else 0.0
    except PsycopgError as e:
        logging.error(f"Error al cargar dominio: {str(e)}")
        return 0.0

def recomendar_tema(usuario):
    try:
        dominios = {tema: cargar_dominio(usuario, tema) for tema in temas.keys()}
        if not dominios:
            logging.warning("No hay dominios disponibles, recomendando tema aleatorio")
            return random.choice(list(temas.keys()))
        tema_bajo = min(dominios, key=dominios.get)
        if prerequisitos.get(tema_bajo) and any(cargar_dominio(usuario, prereq) < 0.6 for prereq in prerequisitos[tema_bajo]):
            logging.debug(f"Recomendando prerequisito: {prerequisitos[tema_bajo][0]}")
            return prerequisitos[tema_bajo][0]
        logging.debug(f"Recomendando tema: {tema_bajo}")
        return tema_bajo
    except Exception as e:
        logging.error(f"Error en recomendar_tema: {str(e)}")
        return random.choice(list(temas.keys()))

@app.route('/')
def index():
    return render_template('index.html')

@app.route("/respuesta", methods=["POST"])
@limiter.limit("5 per minute")
def respuesta():
    try:
        logging.debug("Recibiendo solicitud en /respuesta")
        data = request.get_json()
        if not data or "pregunta" not in data:
            logging.error("Solicitud sin pregunta")
            return jsonify({"error": "No se proporcionó una pregunta"}), 400
        pregunta = data.get("pregunta", "").strip().lower()
        usuario = data.get("usuario", "anonimo")
        avatar_id = data.get("avatar_id", "default")
        
        if not pregunta:
            logging.error("Pregunta vacía recibida")
            return jsonify({"error": "La pregunta no puede estar vacía"}), 400

        logging.debug(f"Pregunta recibida: {pregunta}, usuario: {usuario}, avatar_id: {avatar_id}")

        if "temas que contengan" in pregunta:
            query = pregunta.replace("temas que contengan", "").strip().lower()
            todos_los_temas = list(temas.keys()) + list(cargar_aprendizaje().keys())
            temas_filtrados = [tema for tema in todos_los_temas if query in tema.lower()]
            progreso = cargar_progreso(usuario)
            if temas_filtrados:
                return jsonify({"respuesta": f"Temas encontrados: {', '.join(temas_filtrados)}. Tienes {progreso['puntos']} puntos y has aprendido: {progreso['temas_aprendidos'] or 'ningún tema aún'}."})
            else:
                return jsonify({"respuesta": f"No se encontraron temas que contengan '{query}'."})
        
        if "temas" in pregunta or "qué sabes" in pregunta or "enseñar" in pregunta:
            todos_los_temas = list(temas.keys()) + list(cargar_aprendizaje().keys())
            progreso = cargar_progreso(usuario)
            return jsonify({"respuesta": f"Puedo enseñarte sobre: {', '.join(todos_los_temas)}. Tienes {progreso['puntos']} puntos y has aprendido: {progreso['temas_aprendidos'] or 'ningún tema aún'}."})

        respuesta_text = buscar_respuesta_app(pregunta, usuario)
        if len(respuesta_text) > MAX_RESPUESTA_LEN:
            respuesta_text = respuesta_text[:MAX_RESPUESTA_LEN] + "... (texto truncado)"

        especial = {
            "poo": {"imagen": "/static/img/poo.png", "codigo": "class Coche:\n    def __init__(self):\n        self.color = 'rojo'"}
        }.get(pregunta, {})
        video_url = None
        response_data = {"respuesta": respuesta_text, "video_url": video_url}
        if especial.get("imagen"):
            response_data["imagen"] = especial["imagen"]
        if especial.get("codigo"):
            response_data["codigo"] = especial["codigo"]
            
        logging.debug(f"Respuesta enviada: {response_data}")
        return jsonify(response_data)
        
    except Exception as e:
        logging.error(f"Error en /respuesta: {str(e)}")
        return jsonify({"error": f"Error al procesar la pregunta: {str(e)}"}), 500

@app.route("/aprendizaje", methods=["POST"])
@limiter.limit("5 per minute")
def aprendizaje():
    try:
        logging.debug("Recibiendo solicitud en /aprendizaje")
        data = request.get_json()
        pregunta = data.get("pregunta", "").strip().lower().replace("'", "''")
        respuesta = data.get("respuesta", "").strip()
        
        if not pregunta or not respuesta:
            logging.error("Pregunta y respuesta no pueden estar vacías")
            return jsonify({"error": "Pregunta y respuesta no pueden estar vacías"}), 400
        if len(pregunta) > MAX_PREGUNTA_LEN:
            logging.error(f"Pregunta excede el límite de {MAX_PREGUNTA_LEN} caracteres")
            return jsonify({"error": f"La pregunta excede los {MAX_PREGUNTA_LEN} caracteres"}), 400
        if len(respuesta) > MAX_RESPUESTA_LEN:
            logging.error(f"Respuesta excede el límite de {MAX_RESPUESTA_LEN} caracteres")
            return jsonify({"error": f"La respuesta excede los {MAX_RESPUESTA_LEN} caracteres"}), 400
            
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("INSERT INTO aprendizaje (pregunta, respuesta) VALUES (%s, %s) ON CONFLICT (pregunta) DO UPDATE SET respuesta = %s",
                  (pregunta, respuesta, respuesta))
        conn.commit()
        conn.close()
        cargar_aprendizaje.cache_clear()
        
        logging.debug("Aprendizaje guardado exitosamente")
        return jsonify({"mensaje": "¡Aprendido con éxito!"})
        
    except PsycopgError as e:
        logging.error(f"Error en /aprendizaje: {str(e)}")
        return jsonify({"error": f"Error al aprender: {str(e)}"}), 500
    except Exception as e:
        logging.error(f"Error en /aprendizaje: {str(e)}")
        return jsonify({"error": f"Error al aprender: {str(e)}"}), 500

@app.route("/progreso", methods=["GET"])
def progreso():
    try:
        logging.debug("Recibiendo solicitud en /progreso")
        usuario = request.args.get("usuario", "anonimo")
        progreso_data = cargar_progreso(usuario)
        logging.debug(f"Progreso retornado: {progreso_data}")
        return jsonify(progreso_data)
    except Exception as e:
        logging.error(f"Error en /progreso: {str(e)}")
        return jsonify({"error": f"Error al cargar el progreso: {str(e)}"}), 500

@app.route("/actualizar_nivel", methods=["POST"])
def actualizar_nivel():
    try:
        logging.debug("Recibiendo solicitud en /actualizar_nivel")
        data = request.get_json()
        usuario = data.get("usuario", "anonimo")
        nivel = data.get("nivel", "intermedio")
        
        if nivel not in ["basico", "intermedio", "avanzado"]:
            logging.error("Nivel inválido recibido")
            return jsonify({"error": "Nivel inválido"}), 400
            
        progreso = cargar_progreso(usuario)
        guardar_progreso(usuario, progreso["puntos"], progreso["temas_aprendidos"], nivel, progreso["avatar_id"])
        
        logging.debug(f"Nivel actualizado a {nivel} para usuario {usuario}")
        return jsonify({"mensaje": f"Nivel actualizado a {nivel}"})
        
    except Exception as e:
        logging.error(f"Error en /actualizar_nivel: {str(e)}")
        return jsonify({"error": f"Error al actualizar el nivel: {str(e)}"}), 500

@app.route("/avatars", methods=["GET"])
def avatars():
    try:
        logging.debug("Recibiendo solicitud en /avatars")
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url FROM avatars")
        avatars = [{"avatar_id": row[0], "nombre": row[1], "url": row[2]} for row in c.fetchall()]
        conn.close()
        result = avatars if avatars else [
            {"avatar_id": "default", "nombre": "Avatar Predeterminado", "url": "/static/img/default-avatar.png"},
            {"avatar_id": "poo", "nombre": "POO Avatar", "url": "/static/img/poo.png"}
        ]
        logging.debug(f"Avatares retornados: {result}")
        return jsonify(result)
    except PsycopgError as e:
        logging.error(f"Error al obtener avatares: {str(e)}")
        return jsonify([
            {"avatar_id": "default", "nombre": "Avatar Predeterminado", "url": "/static/img/default-avatar.png"},
            {"avatar_id": "poo", "nombre": "POO Avatar", "url": "/static/img/poo.png"}
        ])

@app.route("/quiz", methods=["GET"])
def quiz():
    try:
        logging.debug("Recibiendo solicitud en /quiz")
        usuario = request.args.get("usuario", "anonimo")
        temas_disponibles = list(temas.keys())
        
        if not temas_disponibles:
            logging.error("No hay temas disponibles para el quiz")
            return jsonify({"error": "No hay temas disponibles para el quiz"}), 400
            
        tema = recomendar_tema(usuario)
        progreso = cargar_progreso(usuario)
        dificultad = "facil" if progreso["nivel"] == "basico" else "medio" if progreso["nivel"] == "intermedio" else "dificil"
        pregunta = f"¿Qué es {tema} en nivel {dificultad}?"
        opciones = [temas[tema].split('.')[0]]
        opciones.extend(random.sample([temas[t].split('.')[0] for t in temas if t != tema], min(3, len(temas)-1)))
        random.shuffle(opciones)
        
        result = {"pregunta": pregunta, "opciones": opciones, "respuesta_correcta": temas[tema].split('.')[0], "tema": tema}
        logging.debug(f"Quiz generado: {result}")
        return jsonify(result)
        
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar el quiz: {str(e)}"}), 500

@app.route("/responder_quiz", methods=["POST"])
def responder_quiz():
    try:
        logging.debug("Recibiendo solicitud en /responder_quiz")
        data = request.get_json()
        if not data or "respuesta" not in data or "respuesta_correcta" not in data or "tema" not in data:
            logging.error("Faltan datos en la solicitud de responder quiz")
            return jsonify({"error": "Faltan datos en la solicitud"}), 400
            
        usuario = data.get("usuario", "anonimo")
        respuesta = data.get("respuesta").strip()
        respuesta_correcta = data.get("respuesta_correcta").strip()
        tema = data.get("tema").strip()
        progreso = cargar_progreso(usuario)
        es_correcta = respuesta == respuesta_correcta
        delta_dominio = 0.1 if es_correcta else -0.05
        actualizar_dominio(usuario, tema, delta_dominio)

        if es_correcta:
            puntos = 20 if progreso["nivel"] == "avanzado" else 10
            nuevos_puntos = progreso["puntos"] + puntos
            temas_aprendidos = progreso["temas_aprendidos"]
            if tema not in temas_aprendidos.split(","):
                temas_aprendidos += ("," if temas_aprendidos else "") + tema
            guardar_progreso(usuario, nuevos_puntos, temas_aprendidos, progreso["nivel"], progreso["avatar_id"])
            mensaje = f"¡Correcto! Has ganado {puntos} puntos. {temas[tema]} ¿Quieres otro quiz?"
        else:
            mensaje = f"Respuesta incorrecta. La respuesta correcta es: {respuesta_correcta}. ¿Quieres intentarlo de nuevo?"
        
        log_interaccion(usuario, f"Quiz sobre {tema}", mensaje)
        
        logging.debug(f"Respuesta quiz: {mensaje}, es_correcta: {es_correcta}")
        return jsonify({"respuesta": mensaje, "es_correcta": es_correcta})
        
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({"error": f"Error al procesar la respuesta del quiz: {str(e)}"}), 500

@app.route("/recomendacion", methods=["GET"])
def recomendacion():
    try:
        logging.debug("Recibiendo solicitud en /recomendacion")
        usuario = request.args.get("usuario", "anonimo")
        recomendacion_tema = recomendar_tema(usuario)
        logging.debug(f"Recomendación: {recomendacion_tema}")
        return jsonify({"recomendacion": recomendacion_tema})
    except Exception as e:
        logging.error(f"Error en /recomendacion: {str(e)}")
        return jsonify({"error": f"Error al recomendar tema: {str(e)}"}), 500

@app.route("/analytics", methods=["GET"])
def analytics():
    try:
        logging.debug("Recibiendo solicitud en /analytics")
        usuario = request.args.get("usuario", "anonimo")
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        c = conn.cursor()
        c.execute("SELECT tema, dominio, aciertos, fallos FROM progreso_tema WHERE usuario = %s", (usuario,))
        data = c.fetchall()
        conn.close()
        result = [
            {
                "tema": row[0],
                "dominio": float(row[1]),
                "tasa_acierto": float(row[2] / (row[2] + row[3] or 1))  # Evitar división por cero
            } for row in data
        ]
        logging.debug(f"Datos de analytics: {result}")
        return jsonify(result)
    except PsycopgError as e:
        logging.error(f"Error al conectar a la base de datos en /analytics: {str(e)}")
        return jsonify([])
    except Exception as e:
        logging.error(f"Error en /analytics: {str(e)}")
        return jsonify([])

@app.route("/tts", methods=["POST"])
def tts():
    try:
        logging.debug("Recibiendo solicitud en /tts")
        data = request.get_json()
        text = data.get("text", "").strip()

        if not text:
            logging.error("Texto vacío en solicitud TTS")
            return jsonify({"error": "Texto vacío"}), 400

        if len(text) > MAX_RESPUESTA_LEN:
            logging.error(f"Texto excede el límite de {MAX_RESPUESTA_LEN} caracteres")
            return jsonify({"error": f"El texto excede los {MAX_RESPUESTA_LEN} caracteres"}), 400

        tts = gTTS(text=text, lang='es')
        audio_buffer = io.BytesIO()
        tts.write_to_fp(audio_buffer)
        audio_buffer.seek(0)
        
        logging.debug("Audio generado exitosamente")
        return audio_buffer.read(), 200, {'Content-Type': 'audio/mp3'}
        
    except Exception as e:
        logging.error(f"Error en /tts: {str(e)}")
        return jsonify({"error": f"Error al generar audio: {str(e)}"}), 500

if __name__ == "__main__":
    init_db()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("0.0.0.0", 5000))
        sock.close()
        webbrowser.open("http://localhost:5000")
    except OSError:
        logging.warning("Puerto 5000 ya en uso, no abriendo nueva pestaña.")
    app.run(debug=True, host='0.0.0.0', port=5000)