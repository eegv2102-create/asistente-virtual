import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file
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

# Cargar temas y prerequisitos
try:
    with open("temas.json", "r", encoding="utf-8") as f:
        temas = json.load(f)
    logging.info("Temas cargados: %s", list(temas.keys()))
except Exception as e:
    logging.error(f"Error cargando temas.json: {str(e)}")
    temas = {}

try:
    with open("prerequisitos.json", "r", encoding="utf-8") as f:
        prerequisitos = json.load(f)
    logging.info("Prerequisitos cargados: %s", list(prerequisitos.keys()))
except Exception as e:
    logging.error(f"Error cargando prerequisitos.json: {str(e)}")
    prerequisitos = {}

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

def buscar_respuesta_app(pregunta, nivel_explicacion="basica", historial=None):
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    # Manejo de mensajes simples
    respuestas_simples = {
        "hola": "¡Hola! Estoy listo para ayudarte con Programación Avanzada. ¿Qué tema quieres explorar? ¿Deseas saber más?",
        "gracias": "¡De nada! Sigue aprendiendo, estoy aquí para apoyarte. ¿Deseas saber más?",
        "adiós": "¡Hasta pronto! Espero verte de nuevo para seguir aprendiendo. ¿Deseas saber más?"
    }
    if pregunta.lower().strip() in respuestas_simples:
        return respuestas_simples[pregunta.lower().strip()]

    # Buscar tema en temas.json
    tema_encontrado = None
    for tema_id, tema_data in temas.items():
        if tema_id in pregunta.lower() or any(kw.lower() in pregunta.lower() for kw in tema_data["palabras_clave"]):
            tema_encontrado = tema_id
            break

    # Generar prerequisitos si corresponde
    prereq_text = ""
    if tema_encontrado and tema_encontrado in prerequisitos:
        prereq_text = (
            "\n\n**Prerequisitos recomendados**: Antes de profundizar en este tema, te sugiero repasar:\n" +
            "\n".join([f"- {temas[p]['descripcion']}" for p in prerequisitos[tema_encontrado] if p in temas])
        )

    # Generar contexto del historial
    contexto = ""
    if historial:
        contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

    # Personalizar respuesta según el nivel de explicación
    prompt = (
        "Eres un asistente virtual con avatar inteligente diseñado para apoyar a estudiantes de Ingeniería en Telemática en la asignatura de Programación Avanzada.\n\n"
        "Tu comportamiento debe ser:\n"
        "1. Responder de forma clara, completa y actualizada sobre temas de la asignatura (POO, patrones de diseño, MVC, bases de datos, integración con Java, etc.).\n"
        "2. Aceptar preguntas con errores ortográficos o expresiones informales, incluyendo mensajes cortos.\n"
        "3. Ser amigable y motivador, usando un tono cercano pero profesional.\n"
        "4. Al final de cada respuesta, siempre preguntar: \n"
        "   \"¿Deseas saber más?\"\n"
        "5. Personalizar la respuesta según el nivel de explicación solicitado: básica (conceptos simples), ejemplos (con código práctico), o avanzada (teórica y detallada).\n"
        f"Contexto: {json.dumps(temas)}\n"
        f"Prerequisitos: {json.dumps(prerequisitos)}\n"
        f"Historial: {contexto}\n"
        f"Nivel de explicación: {nivel_explicacion}\n"
        f"Pregunta: {pregunta}"
    )

    completion = client.chat.completions.create(
        model="llama3-70b-8192",
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": pregunta}
        ],
        max_tokens=1000,
        temperature=0.5
    )
    respuesta = completion.choices[0].message.content
    if tema_encontrado:
        if nivel_explicacion == "basica":
            respuesta = f"**{tema_encontrado} (Explicación básica)**: {temas[tema_encontrado]['descripcion']}{prereq_text}\n\n¿Deseas saber más?"
        elif nivel_explicacion == "ejemplos":
            respuesta = (
                f"**{tema_encontrado} (Explicación con ejemplos)**: {temas[tema_encontrado]['descripcion']}\n\n"
                f"**Ejemplo de código**:\n{temas[tema_encontrado].get('descripcion', '').split('Ejemplo')[1] if 'Ejemplo' in temas[tema_encontrado]['descripcion'] else '// Código de ejemplo no disponible'}\n"
                f"{prereq_text}\n\n¿Deseas saber más?"
            )
        else:  # avanzada
            respuesta = (
                f"**{tema_encontrado} (Explicación avanzada)**: {temas[tema_encontrado]['descripcion']}\n\n"
                f"**Detalles teóricos**: Este tema implica conceptos avanzados que requieren un entendimiento profundo de sus fundamentos.\n"
                f"{prereq_text}\n\n¿Deseas saber más?"
            )
    else:
        respuesta += f"{prereq_text}\n\n¿Deseas saber más?"

    return respuesta

# Rutas
@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(app.root_path, 'static'), 'favicon.ico', mimetype='image/vnd.microsoft.icon')

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/saludo_inicial", methods=["GET"])
def saludo_inicial():
    try:
        usuario = "anonimo"
        avatar_id = request.args.get("avatar_id", "default")
        avatar_id = bleach.clean(avatar_id[:50])
        respuesta_text = (
            "¡Hola! Soy tu asistente virtual para Programación Avanzada en Ingeniería en Telemática. "
            "Estoy aquí para ayudarte con temas como POO, patrones de diseño, bases de datos y más. "
            "¿Qué quieres aprender hoy? ¿Deseas saber más?"
        )
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
                      (usuario, "Saludo inicial", respuesta_text, avatar[1] if avatar else ""))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar en logs: {str(e)}")

        response_data = {
            "respuesta": respuesta_text,
            "avatar_url": avatar[0] if avatar else "/static/img/default-avatar.png",
            "animation_url": avatar[1] if avatar else ""
        }
        logging.info(f"Saludo inicial enviado: {response_data}")
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"Error en /saludo_inicial: {str(e)}")
        return jsonify({"error": f"Error al procesar el saludo inicial: {str(e)}"}), 500

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
        nivel_explicacion = bleach.clean(data.get("nivel_explicacion", "basica")[:20])
        historial = data.get("historial", [])

        if not pregunta:
            logging.info("Pregunta vacía ignorada")
            return jsonify({"respuesta": "Por favor, escribe una pregunta para continuar. ¿Deseas saber más?"})

        respuesta_text = buscar_respuesta_app(pregunta, nivel_explicacion, historial)
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

@app.route("/quiz", methods=["POST"])
def quiz():
    try:
        data = request.get_json()
        if not data or "tema" not in data:
            logging.error("Solicitud inválida: falta tema")
            return jsonify({"error": "El tema no puede estar vacío"}), 400

        tema = bleach.clean(data.get("tema", "").strip()[:50])
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        tipo_quiz = bleach.clean(data.get("tipo_quiz", "opciones")[:20])

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            "Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            f"Tu tarea es generar un quiz de {tipo_quiz} sobre el tema proporcionado. "
            f"Si tipo_quiz es 'opciones', genera 3 preguntas de opción múltiple, cada una con 4 opciones y una respuesta correcta. "
            f"Si tipo_quiz es 'verdadero_falso', genera 3 preguntas de verdadero o falso. "
            f"El tema es: {tema}. "
            "Devuelve el resultado en formato JSON con la estructura: "
            "{\"quiz\": [{\"pregunta\": \"texto\", \"opciones\": [\"op1\", \"op2\", ...], \"respuesta_correcta\": \"op_correcta\", \"tema\": \"tema\", \"nivel\": \"basico|intermedio|avanzado\"}]}"
        )

        completion = client.chat.completions.create(
            model="llama3-70b-8192",
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": f"Genera un quiz de {tipo_quiz} sobre {tema}."}
            ],
            max_tokens=1500,
            temperature=0.5
        )

        response_text = completion.choices[0].message.content
        try:
            quiz_data = json.loads(response_text)
            if not isinstance(quiz_data.get("quiz"), list) or len(quiz_data["quiz"]) != 3:
                raise ValueError("Formato de quiz inválido o número incorrecto de preguntas")
            for q in quiz_data["quiz"]:
                if not all(key in q for key in ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]):
                    raise ValueError("Faltan campos requeridos en una pregunta del quiz")
                if tipo_quiz == "opciones" and len(q["opciones"]) != 4:
                    raise ValueError("Cada pregunta de opción múltiple debe tener exactamente 4 opciones")
                if tipo_quiz == "verdadero_falso" and len(q["opciones"]) != 2:
                    raise ValueError("Cada pregunta de verdadero/falso debe tener exactamente 2 opciones")
        except json.JSONDecodeError:
            logging.error("Respuesta de Groq no es un JSON válido")
            return jsonify({"error": "Error al procesar el formato del quiz"}), 500
        except ValueError as ve:
            logging.error(f"Error en el formato del quiz: {str(ve)}")
            return jsonify({"error": f"Error en el formato del quiz: {str(ve)}"}), 500

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {tema}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar el quiz: {str(e)}"}), 500

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

        es_correcta = respuesta == respuesta_correcta
        if es_correcta:
            puntos += 10
            if tema not in temas_aprendidos:
                temas_aprendidos.append(tema)
            mensaje = f"✅ ¡Correcto! Has ganado 10 puntos. Tema: {tema}. ¿Deseas saber más?"
        else:
            mensaje = f"❌ Incorrecto. La respuesta correcta era: {respuesta_correcta}. ¿Deseas saber más?"

        guardar_progreso(usuario, puntos, ",".join(temas_aprendidos))
        logging.info(f"Quiz respondido por {usuario}: {mensaje}")
        return jsonify({"respuesta": mensaje, "es_correcta": es_correcta})
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
        if not all(c.isprintable() or c.isspace() for c in text):
            logging.error("Texto contiene caracteres no válidos")
            return jsonify({"error": "El texto contiene caracteres no válidos"}), 400
        try:
            tts = gTTS(text=text, lang='es', tld='com.mx')
            audio_io = io.BytesIO()
            tts.write_to_fp(audio_io)
            audio_io.seek(0)
            logging.info("Audio generado exitosamente")
            return send_file(audio_io, mimetype='audio/mp3')
        except Exception as gtts_error:
            logging.error(f"Error en gTTS: {str(gtts_error)}")
            return jsonify({"error": f"Error en la generación de audio: {str(gtts_error)}"}), 500
    except Exception as e:
        logging.error(f"Error en /tts: {str(e)}")
        return jsonify({"error": f"Error al procesar la solicitud: {str(e)}"}), 500

@app.route("/recommend", methods=["POST"])
def recommend():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        historial = data.get("historial", [])

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = list(temas.keys())

        # Filtrar temas no aprendidos
        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        contexto = "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        prompt = (
            "Eres un tutor de Programación Avanzada para estudiantes de Ingeniería en Telemática. "
            "Tu tarea es recomendar un tema de Programación Avanzada basado en el historial de interacciones y los temas ya aprendidos. "
            "Elige un tema de los disponibles que no haya sido aprendido, considerando el contexto del historial. "
            "Devuelve solo el nombre del tema recomendado (por ejemplo, 'Patrones de diseño') sin explicaciones adicionales."
            f"Contexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_no_aprendidos)}"
        )

        completion = client.chat.completions.create(
            model="llama3-70b-8192",
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Recomienda un tema."}
            ],
            max_tokens=50,
            temperature=0.5
        )

        recomendacion = completion.choices[0].message.content.strip()
        if not recomendacion or recomendacion not in temas_disponibles:
            recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else "Patrones de diseño"

        logging.info(f"Recomendación para usuario {usuario}: {recomendacion}")
        return jsonify({"recommendation": recomendacion})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        return jsonify({"error": f"Error al generar la recomendación: {str(e)}"}), 500

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