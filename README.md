🧠 YELIA: Asistente Virtual para POO y Desarrollo de Software
Este proyecto es un asistente virtual educativo diseñado para responder preguntas y proporcionar información sobre la Programación Orientada a Objetos (POO) y temas relacionados con el desarrollo de software. Utiliza un modelo de lenguaje de IA para ofrecer explicaciones claras, ejemplos de código y quizzes interactivos.

El proyecto está construido con Flask en el backend y una interfaz de usuario dinámica con JavaScript, HTML y CSS en el frontend.

✨ Características Principales
Chat con IA: Un asistente conversacional que proporciona explicaciones detalladas y ejemplos de código sobre conceptos de POO y desarrollo.

Modo Quiz: Pon a prueba tus conocimientos con preguntas aleatorias sobre los temas del curso.

Historial de Chats: Guarda y accede a conversaciones anteriores.

Personalización: Elige entre varios avatares de IA y alterna entre el modo claro y oscuro.

Reconocimiento de Voz: Interactúa con el asistente usando tu voz.

Totalmente Desplegable: El proyecto está configurado para ser fácilmente desplegado en plataformas como Render.

🚀 Requisitos de Instalación
Para ejecutar este proyecto de manera local, necesitas tener instalado Python 3.10 o superior y una clave de API de Groq.

Clona el repositorio:

Bash

git clone https://github.com/eegv2102-create/asistente-virtual.git
cd asistente-virtual
Crea un entorno virtual e instálalo:

Bash

python -m venv venv
# En Windows
.\venv\Scripts\activate
# En macOS/Linux
source venv/bin/activate
Instala las dependencias:

Bash

pip install -r requirements.txt
Configura tus variables de entorno:
Crea un archivo .env en la raíz del proyecto y añade las siguientes variables:

GROQ_API_KEY="tu_clave_de_groq_aqui"
SECRET_KEY="una_clave_secreta_para_flask"
DATABASE_URL="postgresql://usuario:contraseña@host:puerto/nombre_bd"
GROQ_API_KEY: Obtén esta clave desde tu cuenta de Groq.

SECRET_KEY: Una clave aleatoria para la seguridad de la sesión de Flask.

DATABASE_URL: La URL de tu base de datos PostgreSQL.

▶️ Uso
Ejecuta la aplicación:
Para ejecutar la aplicación localmente, usa gunicorn:

Bash

gunicorn app:app -b 0.0.0.0:5000
Accede a la aplicación:
Abre tu navegador y navega a http://127.0.0.1:5000.

📂 Estructura del Proyecto
app.py: El archivo principal de la aplicación Flask. Contiene las rutas, la lógica del servidor y la comunicación con la base de datos y la API de Groq.

temas.json: Un archivo que contiene el contenido educativo estructurado en unidades y temas.

requirements.txt: Las dependencias de Python del proyecto.

runtime.txt: Especifica la versión de Python para el entorno de despliegue.

templates/:

index.html: La página principal de la aplicación.

static/:

css/: Contiene los estilos (style.css).

js/: Contiene la lógica del frontend (script.js).