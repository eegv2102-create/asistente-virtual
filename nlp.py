import re
import json
import logging

# Configuración de logging optimizada para Render
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Eliminamos la búsqueda TF-IDF ya que ahora siempre usamos Groq

def classify_intent(text):
    """
    Clasificador de intenciones basado en palabras clave y regex.
    """
    try:
        text_lower = text.lower()
        if any(word in text_lower for word in ["hola", "saludo", "buenos dias"]):
            return "saludo"
        elif re.search(r"ejemplo.*c[oó]digo|implementaci[oó]n|java", text_lower):
            return "ejemplo_codigo"
        elif any(word in text_lower for word in ["definicion", "que es", "explica"]):
            return "definicion"
        elif any(word in text_lower for word in ["quiz", "prueba", "examen"]):
            return "quiz"
        return "definicion"
    except Exception as e:
        logging.error(f"Error al clasificar intención: {e}")
        return "definicion"

def normalize(text):
    """
    Normalización simple del texto.
    """
    try:
        return text.lower().strip()
    except Exception as e:
        logging.error(f"Error al normalizar texto: {e}")
        return text