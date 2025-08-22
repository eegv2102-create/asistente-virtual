import time
import json
import os
import random
import logging
import socket
import webbrowser
from flask import Flask, render_template, request, jsonify, send_from_directory, send_file, session
from flask_session import Session
from dotenv import load_dotenv
from groq import Groq
import psycopg2
from psycopg2 import Error as PsycopgError, sql
import httpx
import bleach
from gtts import gTTS
import io
import retrying
import re
import uuid


# Configurar logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Cargar variables de entorno
load_dotenv()

# Inicializar Flask
app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'tu_clave_secreta')
app.config['SESSION_TYPE'] = 'filesystem'
Session(app)

# Inicializar Groq client globalmente
client = Groq(api_key=os.getenv('GROQ_API_KEY'))

# Definir get_db_connection con reintentos
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def get_db_connection():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        conn.set_session(autocommit=False)
        logging.info("Conexión a la base de datos establecida")
        return conn
    except Exception as e:
        logging.error(f"Error al conectar con la base de datos: {str(e)}")
        raise

def _col_exists(cursor, table, column):
    cursor.execute("""
        SELECT 1 FROM information_schema.columns
        WHERE table_name = %s AND column_name = %s
    """, (table, column))
    return cursor.fetchone() is not None

def _ensure_created_at(cursor, table):
    # Si existe "timestamp" pero no "created_at" => renombrar
    has_created = _col_exists(cursor, table, 'created_at')
    has_timestamp = _col_exists(cursor, table, 'timestamp')
    if has_timestamp and not has_created:
        cursor.execute(
            sql.SQL('ALTER TABLE {} RENAME COLUMN "timestamp" TO created_at')
               .format(sql.Identifier(table))
        )
        logging.info(f"[migración] Renombrado timestamp -> created_at en {table}")
    # Si no existe ninguno => añadir created_at
    elif not has_timestamp and not has_created:
        cursor.execute(
            sql.SQL("ALTER TABLE {} ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
               .format(sql.Identifier(table))
        )
        logging.info(f"[migración] Añadido created_at en {table}")

# Validar variables de entorno
if not os.getenv("GROQ_API_KEY"):
    logging.error("GROQ_API_KEY no configurada")
    exit(1)
if not os.getenv("DATABASE_URL"):
    logging.error("DATABASE_URL no configurada")
    exit(1)

def init_db():
    conn = None
    try:
        conn = get_db_connection()
        c = conn.cursor()

        # 1) Crear tablas si no existen (version canónica con created_at)
        c.execute('''CREATE TABLE IF NOT EXISTS progreso
                     (usuario TEXT PRIMARY KEY,
                      puntos INTEGER DEFAULT 0,
                      temas_aprendidos TEXT DEFAULT '',
                      avatar_id TEXT DEFAULT 'default',
                      temas_recomendados TEXT DEFAULT '')''')

        c.execute('''CREATE TABLE IF NOT EXISTS logs
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT,
                      pregunta TEXT,
                      respuesta TEXT,
                      nivel_explicacion TEXT,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS avatars
                     (avatar_id TEXT PRIMARY KEY,
                      nombre TEXT,
                      url TEXT,
                      animation_url TEXT)''')

        c.execute("""INSERT INTO avatars (avatar_id, nombre, url, animation_url)
                     VALUES (%s, %s, %s, %s)
                     ON CONFLICT (avatar_id) DO NOTHING""",
                  ("default", "Avatar Predeterminado", "/static/img/default-avatar.png", ""))

        c.execute('''CREATE TABLE IF NOT EXISTS quiz_logs
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT NOT NULL,
                      pregunta TEXT NOT NULL,
                      respuesta TEXT NOT NULL,
                      es_correcta BOOLEAN NOT NULL,
                      puntos INTEGER NOT NULL,
                      tema TEXT NOT NULL,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS conversations
                     (id SERIAL PRIMARY KEY,
                      usuario TEXT NOT NULL,
                      nombre TEXT DEFAULT 'Nuevo Chat',
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS messages
                     (id SERIAL PRIMARY KEY,
                      conv_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
                      role TEXT NOT NULL,
                      content TEXT NOT NULL,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

        # 2) Migrar tablas antiguas que tenían "timestamp"
        for table in ["logs", "quiz_logs", "conversations", "messages"]:
            _ensure_created_at(c, table)

        # 3) Índices (siempre sobre created_at)
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_progreso ON progreso(usuario)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_logs ON logs(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_quiz_logs ON quiz_logs(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_usuario_conversations ON conversations(usuario, created_at)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_conv_messages ON messages(conv_id, created_at)')

        conn.commit()
        logging.info("Base de datos inicializada correctamente (tablas + migraciones + índices)")
        return True
    except PsycopgError as e:
        logging.error(f"Error al inicializar la base de datos: {str(e)}")
        if conn:
            conn.rollback()
        raise
    except Exception as e:
        logging.error(f"Error inesperado al inicializar la base de datos: {str(e)}")
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()



def migrate_columns():
    try:
        conn = get_db_connection()
        c = conn.cursor()
        # Verificar y renombrar columnas antiguas
        for table in ["logs", "quiz_logs", "messages"]:
            c.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = %s AND column_name = 'timestamp'
            """, (table,))
            if c.fetchone():
                c.execute(f'ALTER TABLE {table} RENAME COLUMN "timestamp" TO created_at')
                logging.info(f"Columna 'timestamp' renombrada a 'created_at' en {table}")
        conn.commit()
        conn.close()
    except Exception as e:
        logging.error(f"Error en migración de columnas: {str(e)}")


def cargar_temas():
    global temas
    try:
        with open('temas.json', 'r', encoding='utf-8') as f:
            temas = json.load(f)
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        logging.info(f"Temas cargados: {temas_disponibles}")
        return temas_disponibles
    except FileNotFoundError:
        logging.error("Archivo temas.json no encontrado")
        temas = {}
        return [
            'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
            'Polimorfismo', 'Clases Abstractas e Interfaces', 'Lenguaje de Modelado Unificado (UML)',
            'Diagramas UML', 'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
            'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
        ]

temas = {}
TEMAS_DISPONIBLES = cargar_temas()

def cargar_progreso(usuario):
    try:
        conn = get_db_connection()
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
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO progreso (usuario, puntos, temas_aprendidos, avatar_id) VALUES (%s, %s, %s, %s) "
                  "ON CONFLICT (usuario) DO UPDATE SET puntos = %s, temas_aprendidos = %s, avatar_id = %s",
                  (usuario, puntos, temas_aprendidos, avatar_id, puntos, temas_aprendidos, avatar_id))
        conn.commit()
        conn.close()
        logging.info(f"Progreso guardado para usuario {usuario}: puntos={puntos}, temas={temas_aprendidos}")
    except PsycopgError as e:
        logging.error(f"Error al guardar progreso: {str(e)}")

def guardar_mensaje(usuario, conv_id, role, content):
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO messages (conv_id, role, content) VALUES (%s, %s, %s)", (conv_id, role, content))
        conn.commit()
        conn.close()
        logging.info(f"Mensaje guardado: usuario={usuario}, conv_id={conv_id}, role={role}")
    except PsycopgError as e:
        logging.error(f"Error al guardar mensaje: {str(e)}")

@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def call_groq_api(messages, model, max_tokens, temperature):
    try:
        return client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature
        )
    except Exception as e:
        logging.error(f"Error en Groq API: {str(e)}")
        if '503' in str(e):
            raise Exception("Groq API unavailable (503). Check https://groqstatus.com/")
        raise

@app.route('/messages/<int:conv_id>', methods=['GET', 'POST'])
def handle_messages(conv_id):
    usuario = session.get('usuario', 'anonimo')

    if request.method == 'GET':
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("""
                SELECT id, role, content, timestamp
                FROM messages
                WHERE conv_id = %s
                ORDER BY timestamp ASC
            """, (conv_id,))
            rows = c.fetchall()
            conn.close()

            messages = [
                {
                    "id": r[0],
                    "role": r[1],
                    "content": r[2],
                    "created_at": r[3].isoformat()  # 🔑 aquí lo mantenemos como "created_at" en JSON
                } for r in rows
            ]
            return jsonify({"messages": messages})
        except Exception as e:
            logging.error(f"Error obteniendo mensajes: {str(e)}")
            return jsonify({"error": "No se pudieron obtener los mensajes"}), 500

    elif request.method == 'POST':
        try:
            data = request.get_json()
            role = data.get("role", "user")
            content = data.get("content", "")

            conn = get_db_connection()
            c = conn.cursor()
            c.execute("""
                INSERT INTO messages (conv_id, role, content, timestamp)
                VALUES (%s, %s, %s, NOW()) RETURNING id, timestamp
            """, (conv_id, role, content))
            row = c.fetchone()
            conn.commit()
            conn.close()

            return jsonify({
                "id": row[0],
                "role": role,
                "content": content,
                "created_at": row[1].isoformat()
            })
        except Exception as e:
            logging.error(f"Error guardando mensaje: {str(e)}")
            return jsonify({"error": "No se pudo guardar el mensaje"}), 500

        
@app.route('/conversations/<int:conv_id>', methods=['DELETE', 'PUT'])
def manage_conversation(conv_id):
    usuario = session.get('usuario', 'anonimo')
    if request.method == 'DELETE':
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("DELETE FROM conversations WHERE id = %s AND usuario = %s", (conv_id, usuario))
            if c.rowcount == 0:
                conn.close()
                return jsonify({'error': 'Conversación no encontrada o no autorizada'}), 404
            conn.commit()
            conn.close()
            if session.get('current_conv_id') == conv_id:
                session.pop('current_conv_id', None)
            return jsonify({'success': True})
        except Exception as e:
            logging.error(f"Error eliminando conversación: {str(e)}")
            return jsonify({'error': f"No se pudo eliminar la conversación: {str(e)}"}), 500
    elif request.method == 'PUT':
        try:
            data = request.get_json()
            nuevo_nombre = bleach.clean(data.get('nombre', 'Nuevo Chat')[:100])
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("UPDATE conversations SET nombre = %s WHERE id = %s AND usuario = %s", (nuevo_nombre, conv_id, usuario))
            if c.rowcount == 0:
                conn.close()
                return jsonify({'error': 'Conversación no encontrada o no autorizada'}), 404
            conn.commit()
            conn.close()
            return jsonify({'success': True, 'nombre': nuevo_nombre})
        except Exception as e:
            logging.error(f"Error renombrando conversación: {str(e)}")
            return jsonify({'error': f"No se pudo renombrar la conversación: {str(e)}"}), 500

@app.route('/conversations', methods=['POST'])
def create_conversation():
    usuario = session.get('usuario', 'anonimo')
    try:
        data = request.get_json(silent=True) or {}
        nombre = bleach.clean(data.get("nombre", "Nuevo Chat")[:100])

        conn = get_db_connection()
        c = conn.cursor()
        c.execute("INSERT INTO conversations (usuario, nombre) VALUES (%s, %s) RETURNING id, created_at",
                  (usuario, nombre))
        row = c.fetchone()
        conv_id = row[0]
        conn.commit()
        conn.close()

        # Guardar en sesión como conversación activa
        session['current_conv_id'] = conv_id

        return jsonify({"id": conv_id, "nombre": nombre, "created_at": row[1].isoformat()}), 201
    except Exception as e:
        logging.error(f"Error creando conversación: {str(e)}")
        return jsonify({"error": "No se pudo crear la conversación"}), 500
    
@app.route('/buscar_respuesta', methods=['POST'])
def buscar_respuesta():
    data = request.get_json()
    pregunta = bleach.clean(data.get('pregunta', '')[:500])
    historial = data.get('historial', [])
    nivel_explicacion = data.get('nivel_explicacion', 'basica')
    usuario = session.get('usuario', 'anonimo')

    conv_id = session.get('current_conv_id')
    if not conv_id and pregunta:
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("INSERT INTO conversations (usuario) VALUES (%s) RETURNING id", (usuario,))
            conv_id = c.fetchone()[0]
            conn.commit()
            conn.close()
            session['current_conv_id'] = conv_id
        except Exception as e:
            logging.error(f"Error creando conv en buscar_respuesta: {str(e)}")
            # Continúa sin conv_id si falla, pero loguea
            conv_id = None


    pregunta_norm = pregunta.lower().strip()
    respuestas_simples = {
        r"^(hola|¡hola!|buenos días|buenas tardes|qué tal|hi|saludos)(.*por favor.*)?$": 
            f"¡Hola, {usuario if usuario != 'anonimo' else 'amigo'}! Estoy listo para ayudarte con Programación Avanzada. ¿Qué quieres explorar hoy?",
        r"^(gracias|muchas gracias|gracias por.*|thank you|te agradezco)$": 
            f"¡De nada, {usuario if usuario != 'anonimo' else 'amigo'}! Me alegra ayudarte. ¿Tienes otra pregunta sobre Programación Avanzada?",
        r"^(adiós|bye|hasta luego|nos vemos|chau)$": 
            f"¡Hasta pronto, {usuario if usuario != 'anonimo' else 'amigo'}! Sigue aprendiendo y aquí estaré cuando regreses."
    }

    for patron, respuesta in respuestas_simples.items():
        if re.match(patron, pregunta_norm) and not re.search(r"(explicame|explícame|qué es|como funciona|cómo funciona|dime sobre|quiero aprender|saber más)", pregunta_norm):
            if pregunta and conv_id:
                guardar_mensaje(usuario, conv_id, 'user', pregunta)
                guardar_mensaje(usuario, conv_id, 'bot', respuesta)
            return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})

    if re.match(r"^(qué puedo aprender|qué me puedes enseñar|qué más puedo aprender|dime qué aprender|qué temas hay|qué sabes|qué conoces)$", pregunta_norm):
        tema_sugerido = random.choice(TEMAS_DISPONIBLES)
        respuesta = (
            f"¡Qué buena pregunta, {usuario if usuario != 'anonimo' else 'amigo'}! Te recomiendo explorar {tema_sugerido}. "
            f"Es un tema clave en Programación Avanzada que te ayudará a entender mejor cómo estructurar y optimizar tu código. "
            f"¿Quieres que te explique más sobre {tema_sugerido}? ¿Tienes alguna pregunta adicional sobre este tema?"
        )
        if pregunta and conv_id:
            guardar_mensaje(usuario, conv_id, 'user', pregunta)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta)
        return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})

    prompt_relevancia = (
        f"Eres YELIA, un tutor especializado en Programación Avanzada para Ingeniería en Telemática. "
        f"Determina si la pregunta '{pregunta}' está relacionada con los siguientes temas de Programación Avanzada: {', '.join(TEMAS_DISPONIBLES)}. "
        f"Responde solo 'Sí' o 'No'."
    )
    try:
        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt_relevancia},
                {"role": "user", "content": pregunta}
            ],
            model="llama3-70b-8192",
            max_tokens=10,
            temperature=0.3
        )
        es_relevante = completion.choices[0].message.content.strip().lower() == 'sí'
        if not es_relevante:
            respuesta = (
                f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, solo puedo ayudarte con Programación Avanzada en Ingeniería en Telemática. "
                f"Algunos temas que puedo explicarte son: {', '.join(TEMAS_DISPONIBLES[:3])}. ¿Qué deseas saber de la materia? "
                f"¿Tienes alguna pregunta adicional sobre este tema?"
            )
            if pregunta and conv_id:
                guardar_mensaje(usuario, conv_id, 'user', pregunta)
                guardar_mensaje(usuario, conv_id, 'bot', respuesta)
            return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})
    except Exception as e:
        logging.error(f"Error al verificar relevancia: {str(e)}")
        respuesta = (
            f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, no pude procesar tu pregunta. "
            f"Intenta con una pregunta sobre Programación Avanzada, como {TEMAS_DISPONIBLES[0]}. "
            f"¿Tienes alguna pregunta adicional sobre este tema?"
        )
        if pregunta and conv_id:
            guardar_mensaje(usuario, conv_id, 'user', pregunta)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta)
        return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})

    contexto = ""
    if historial:
        contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

    prompt = (
        f"Eres YELIA, un tutor especializado en Programación Avanzada para estudiantes de Ingeniería en Telemática. "
        f"Responde en español con un tono claro, amigable y motivador a la pregunta: '{pregunta}'. "
        f"Sigue estrictamente estas reglas:\n"
        f"1. Responde solo sobre los temas: {', '.join(TEMAS_DISPONIBLES)}.\n"
        f"2. Nivel de explicación: '{nivel_explicacion}'.\n"
        f"   - 'basica': SOLO una definición clara y concisa (máximo 70 palabras) en texto plano, sin Markdown, negritas, listas, ejemplos, ventajas, comparaciones o bloques de código.\n"
        f"   - 'ejemplos': Definición breve (máximo 80 palabras) + UN SOLO ejemplo en Java (máximo 10 líneas, con formato Markdown). Prohibido incluir ventajas o comparaciones. Usa título '## Ejemplo en Java'.\n"
        f"   - 'avanzada': Definición (máximo 80 palabras) + lista de 2-3 ventajas (máximo 50 palabras) + UN SOLO ejemplo en Java (máximo 10 líneas, con formato Markdown). Puede incluir UNA comparación breve con otro concepto (máximo 20 palabras). Usa títulos '## Ventajas', '## Ejemplo en Java', y '## Comparación' si aplica.\n"
        f"3. Si la pregunta es ambigua (e.g., solo 'Herencia'), asume que se refiere al tema correspondiente de la lista.\n"
        f"4. Usa Markdown para estructurar la respuesta SOLO en 'ejemplos' y 'avanzada' (títulos con ##, lista con -).\n"
        f"5. No hagas preguntas al usuario ni digas 'por favor' ni 'espero haberte ayudado'.\n"
        f"6. No uses emoticones ni emojis.\n"
        f"7. Si no se puede responder, sugiere un tema de la lista.\n"
        f"Contexto: {contexto}\nTimestamp: {int(time.time())}"
    )

    try:
        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": pregunta}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.2
        )
        respuesta = completion.choices[0].message.content.strip()
        if pregunta and conv_id:
            guardar_mensaje(usuario, conv_id, 'user', pregunta)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta)
        return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})
    except Exception as e:
        logging.error(f"Error al procesar respuesta: {str(e)}")
        respuesta = (
            f"Lo siento, {usuario if usuario != 'anonimo' else 'amigo'}, no pude procesar tu pregunta. "
            f"Intenta con una pregunta sobre Programación Avanzada, como {TEMAS_DISPONIBLES[0]}. "
            f"¿Tienes alguna pregunta adicional sobre este tema?"
        )
        if pregunta and conv_id:
            guardar_mensaje(usuario, conv_id, 'user', pregunta)
            guardar_mensaje(usuario, conv_id, 'bot', respuesta)
        return jsonify({'respuesta': respuesta, 'conv_id': conv_id if conv_id else None})

@app.route('/quiz', methods=['POST'])
def quiz():
    try:
        data = request.get_json()
        if not data:
            logging.error("Solicitud sin datos en /quiz")
            return jsonify({"error": "Solicitud inválida: no se proporcionaron datos"}), 400

        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        historial = data.get("historial", [])
        nivel = data.get("nivel", "basico")[:20]
        tema_seleccionado = bleach.clean(data.get("tema", random.choice(TEMAS_DISPONIBLES))[:100])
        if tema_seleccionado not in TEMAS_DISPONIBLES:
            logging.warning(f"Tema no válido: {tema_seleccionado}. Usando tema por defecto.")
            tema_seleccionado = random.choice(TEMAS_DISPONIBLES)

        def validate_quiz_format(quiz_data):
            required_keys = ["pregunta", "opciones", "respuesta_correcta", "tema", "nivel"]
            if not all(key in quiz_data for key in required_keys):
                raise ValueError("Faltan claves requeridas en quiz_data")
            if not isinstance(quiz_data["opciones"], list) or len(quiz_data["opciones"]) != 4:
                raise ValueError("Opciones deben ser una lista de exactamente 4 elementos")
            if quiz_data["respuesta_correcta"] not in quiz_data["opciones"]:
                raise ValueError("Respuesta correcta no está en las opciones")
            if quiz_data["tema"] not in TEMAS_DISPONIBLES:
                raise ValueError(f"Tema {quiz_data['tema']} no es válido")
            if quiz_data["nivel"] not in ["basico", "intermedio", "avanzada"]:
                raise ValueError(f"Nivel {quiz_data['nivel']} no es válido")

        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        prompt = (
            f"Eres YELIA, un tutor especializado en Programación Avanzada para Ingeniería en Telemática. "
            f"Genera una pregunta de opción múltiple (4 opciones, 1 correcta) sobre el tema '{tema_seleccionado}' "
            f"para el nivel '{nivel}'. Devuelve un objeto JSON con las claves: "
            f"'pregunta' (máximo 100 caracteres), 'opciones' (lista de 4 strings, máximo 50 caracteres cada una), "
            f"'respuesta_correcta' (string, debe coincidir con una opción), 'tema' (string), 'nivel' (string). "
            f"No uses Markdown, emojis, ni texto adicional. "
            f"Contexto: {contexto}\nTemas disponibles: {', '.join(TEMAS_DISPONIBLES)}"
        )

        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Genera una pregunta de quiz."}
            ],
            model="llama3-70b-8192",
            max_tokens=300,
            temperature=0.2
        )

        try:
            quiz_data = json.loads(completion.choices[0].message.content.strip())
            validate_quiz_format(quiz_data)
        except (json.JSONDecodeError, ValueError) as e:
            logging.error(f"Error en el formato del quiz de Groq: {str(e)}")
            quiz_data = {
                "pregunta": f"¿Qué permite ocultar los detalles internos de una clase?" if tema_seleccionado == "Encapsulamiento" else f"¿Qué diagrama UML muestra la estructura estática?",
                "opciones": ["Encapsulamiento", "Herencia", "Polimorfismo", "Abstracción"] if tema_seleccionado == "Encapsulamiento" else ["Diagrama de Clases", "Diagrama de Actividades", "Diagrama de Estados", "Diagrama de Componentes"],
                "respuesta_correcta": "Encapsulamiento" if tema_seleccionado == "Encapsulamiento" else "Diagrama de Clases",
                "tema": tema_seleccionado,
                "nivel": "basico"
            }

        try:
            validate_quiz_format(quiz_data)
        except ValueError as e:
            logging.error(f"Formato de quiz inválido: {str(e)}")
            return jsonify({"error": str(e)}), 400

        logging.info(f"Quiz generado para usuario {usuario} sobre tema {quiz_data['tema']}: {quiz_data}")
        return jsonify(quiz_data)
    except Exception as e:
        logging.error(f"Error en /quiz: {str(e)}")
        return jsonify({"error": f"Error al generar quiz: {str(e)}"}), 500

@app.route('/responder_quiz', methods=['POST'])
def responder_quiz():
    try:
        data = request.get_json()
        if not data:
            logging.error("Solicitud sin datos en /responder_quiz")
            return jsonify({'error': 'Solicitud inválida: no se proporcionaron datos'}), 400

        respuesta = bleach.clean(data.get('respuesta', '')[:100])
        respuesta_correcta = bleach.clean(data.get('respuesta_correcta', '')[:100])
        tema = bleach.clean(data.get('tema', 'General')[:50])
        pregunta = bleach.clean(data.get('pregunta', 'Sin pregunta')[:200])

        if not respuesta or not respuesta_correcta:
            logging.error("Faltan respuesta o respuesta_correcta en /responder_quiz")
            return jsonify({'error': 'Faltan respuesta o respuesta_correcta'}), 400

        respuesta_norm = ''.join(respuesta.strip().lower().split())
        respuesta_correcta_norm = ''.join(respuesta_correcta.strip().lower().split())
        es_correcta = respuesta_norm == respuesta_correcta_norm
        logging.info(f"Comparando respuesta: '{respuesta_norm}' con correcta: '{respuesta_correcta_norm}', es_correcta: {es_correcta}")

        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            puntos = 10 if es_correcta else 0
            cursor.execute(
                'INSERT INTO quiz_logs (usuario, pregunta, respuesta, es_correcta, tema, puntos) VALUES (%s, %s, %s, %s, %s, %s)',
                (session.get('usuario', 'anonimo'), pregunta, respuesta, es_correcta, tema, puntos)
            )
            conn.commit()
            cursor.close()
            conn.close()
            logging.info(f"Quiz guardado en quiz_logs: usuario={session.get('usuario', 'anonimo')}, pregunta={pregunta}, respuesta={respuesta}")
        except PsycopgError as e:
            logging.error(f"Error al guardar en quiz_logs: {str(e)}")

        try:
            prompt = (
                f"Eres YELIA, un tutor educativo de Programación Avanzada para Ingeniería en Telemática. "
                f"El usuario respondió a la pregunta: '{pregunta}'. "
                f"La respuesta dada fue: '{respuesta}'. "
                f"La respuesta correcta es: '{respuesta_correcta}'. "
                f"La respuesta es {'correcta' if es_correcta else 'incorrecta'}. "
                f"Sigue estrictamente este formato en Markdown: "
                f"- Si es correcta: '**¡Felicidades, está bien! Seleccionaste: {respuesta}.** [Explicación breve de por qué la respuesta es correcta, máximo 50 palabras]. ¿Deseas saber más del tema o de otro tema?' "
                f"- Si es incorrecta: '**Incorrecto. Seleccionaste: {respuesta}. La respuesta correcta es: {respuesta_correcta}.** [Explicación breve de por qué la respuesta seleccionada es errónea y por qué la correcta es adecuada, máximo 50 palabras]. ¿Deseas saber más del tema o de otro tema?' "
                f"No uses términos fuera de las opciones proporcionadas ni digas 'parcialmente correcta' o 'no completa'. "
                f"Usa solo el contexto de la pregunta y las opciones. "
                f"Responde en español, en formato Markdown."
            )
            response = call_groq_api(
                messages=[{"role": "system", "content": prompt}],
                model="llama3-70b-8192",
                max_tokens=100,
                temperature=0.2
            )
            explicacion = response.choices[0].message.content.strip()
        except Exception as e:
            logging.error(f"Error al generar explicación con Groq: {str(e)}")
            explicacion = (
                f"**{'¡Felicidades, está bien! Seleccionaste: ' + respuesta + '.' if es_correcta else f'Incorrecto. Seleccionaste: {respuesta}. La respuesta correcta es: {respuesta_correcta}.'}** "
                f"{'La respuesta es correcta.' if es_correcta else 'La respuesta seleccionada no es adecuada.'} "
                f"¿Deseas saber más del tema o de otro tema?"
            )

        return jsonify({
            'es_correcta': es_correcta,
            'respuesta': explicacion
        })
    except Exception as e:
        logging.error(f"Error en /responder_quiz: {str(e)}")
        return jsonify({'error': f"Error al procesar la respuesta: {str(e)}"}), 500

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
            tts = gTTS(text=text, lang='es', tld='com.mx', timeout=10)
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
@retrying.retry(wait_fixed=5000, stop_max_attempt_number=3)
def recommend():
    try:
        data = request.get_json()
        usuario = bleach.clean(data.get("usuario", "anonimo")[:50])
        historial = data.get("historial", [])

        progreso = cargar_progreso(usuario)
        temas_aprendidos = progreso["temas_aprendidos"].split(",") if progreso["temas_aprendidos"] else []
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())

        temas_no_aprendidos = [t for t in temas_disponibles if t not in temas_aprendidos]
        if not temas_no_aprendidos:
            temas_no_aprendidos = temas_disponibles

        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("SELECT temas_recomendados FROM progreso WHERE usuario = %s", (usuario,))
            row = c.fetchone()
            temas_recomendados = row[0].split(",") if row and row[0] else []
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al cargar temas recomendados: {str(e)}")
            temas_recomendados = []

        temas_disponibles_para_recomendar = [t for t in temas_no_aprendidos if t not in temas_recomendados[-3:]]
        if not temas_disponibles_para_recomendar:
            temas_disponibles_para_recomendar = temas_no_aprendidos

        contexto = ""
        if historial:
            contexto = "\nHistorial reciente:\n" + "\n".join([f"- Pregunta: {h['pregunta']}\n  Respuesta: {h['respuesta']}" for h in historial[-5:]])

        prompt = (
            "Eres YELIA, un tutor de Programación Avanzada para Ingeniería en Telemática. "
            "Recomienda UN SOLO tema de Programación Avanzada (ej. POO, UML, patrones de diseño, concurrencia) basado en el historial. "
            "Elige un tema que no esté en los últimos 3 recomendados. "
            "Devuelve un objeto JSON con una clave 'recommendation' (ej. {'recommendation': 'Polimorfismo'}). "
            "NO incluyas explicaciones adicionales. "
            f"Contexto: {contexto}\nTemas aprendidos: {','.join(temas_aprendidos)}\nTemas disponibles: {','.join(temas_disponibles_para_recomendar)}\nTimestamp: {int(time.time())}"
        )

        completion = call_groq_api(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": "Recomienda un tema."}
            ],
            model="llama3-70b-8192",
            max_tokens=50,
            temperature=0.7
        )

        try:
            recomendacion_data = json.loads(completion.choices[0].message.content)
            recomendacion = recomendacion_data.get("recommendation", "")
        except json.JSONDecodeError as je:
            logging.error(f"Error al decodificar JSON de Groq en /recommend: {str(je)}")
            recomendacion = random.choice(temas_disponibles_para_recomendar) if temas_disponibles_para_recomendar else random.choice(temas_disponibles)
            logging.warning(f"Usando recomendación de fallback: {recomendacion}")

        temas_recomendados.append(recomendacion)
        if len(temas_recomendados) > 5:
            temas_recomendados = temas_recomendados[-5:]
        try:
            conn = get_db_connection()
            c = conn.cursor()
            c.execute("UPDATE progreso SET temas_recomendados = %s WHERE usuario = %s", (",".join(temas_recomendados), usuario))
            conn.commit()
            conn.close()
        except PsycopgError as e:
            logging.error(f"Error al guardar temas recomendados: {str(e)}")

        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        conv_id = session.get('current_conv_id')
        if conv_id:
            guardar_mensaje(usuario, conv_id, 'bot', recomendacion_texto)
        logging.info(f"Recomendación para usuario {usuario}: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto, 'conv_id': conv_id if conv_id else None})
    except Exception as e:
        logging.error(f"Error en /recommend: {str(e)}")
        recomendacion = random.choice(temas_no_aprendidos) if temas_no_aprendidos else random.choice(temas_disponibles)
        recomendacion_texto = f"Te recomiendo estudiar: {recomendacion}"
        logging.warning(f"Usando recomendación de fallback por error: {recomendacion_texto}")
        return jsonify({"recommendation": recomendacion_texto})

@app.route("/temas", methods=["GET"])
def get_temas():
    try:
        temas_disponibles = []
        for unidad, subtemas in temas.items():
            temas_disponibles.extend(subtemas.keys())
        logging.info(f"Temas disponibles enviados: {temas_disponibles}")
        return jsonify({"temas": temas_disponibles})
    except Exception as e:
        logging.error(f"Error en /temas: {str(e)}")
        return jsonify({"error": "Error al obtener temas"}), 500
    
@app.route('/')
def index():
    try:
        usuario = session.get('usuario', 'anonimo')
        logging.info(f"Accediendo a la ruta raíz para usuario: {usuario}")
        return render_template('index.html')
    except Exception as e:
        logging.error(f"Error al renderizar index.html: {str(e)}")
        return jsonify({'error': 'Error al cargar la página principal'}), 500
    
@app.route('/avatars', methods=['GET'])
def get_avatars():
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT avatar_id, nombre, url, animation_url FROM avatars")
        avatars = [{'avatar_id': row[0], 'nombre': row[1], 'url': row[2], 'animation_url': row[3]} for row in c.fetchall()]
        conn.close()
        logging.info("Avatares enviados: %s", [avatar['nombre'] for avatar in avatars])
        return jsonify({'avatars': avatars})
    except Exception as e:
        logging.error(f"Error al obtener avatares: {str(e)}")
        return jsonify({'avatars': [{'avatar_id': 'default', 'nombre': 'Avatar Predeterminado', 'url': '/static/img/default-avatar.png', 'animation_url': ''}]}), 200

try:
    logging.info("Iniciando inicialización de DB...")
    init_db()  # se ejecuta siempre, ya uses python app.py o gunicorn
    logging.info("DB inicializada con éxito")
except Exception as e:
    logging.error(f"Falló inicialización de DB: {str(e)}. Verifica permisos en Render Postgres o DATABASE_URL.")
    exit(1)

if __name__ == "__main__":
    app.run(debug=False, host='0.0.0.0', port=int(os.getenv("PORT", 10000)))