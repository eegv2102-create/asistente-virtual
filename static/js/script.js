
// script.js - Refactorizado
// Estructura modularizada con secciones claras.
// Variables globales organizadas en un objeto de configuración.
// Manejo de errores robusto en llamadas API con try-catch.

// --- Configuración Global ---
const config = {
    vozActiva: localStorage.getItem('vozActiva') === 'true',
    isListening: false,
    recognition: null,
    selectedAvatar: localStorage.getItem('selectedAvatar') || 'default',
    currentAudio: null,
    userHasInteracted: false,
    pendingWelcomeMessage: null,
    lastVoiceHintTime: 0,
    currentConvId: null,
    historial: JSON.parse(localStorage.getItem('historial') || '[]'),
    quizHistory: JSON.parse(localStorage.getItem('quizHistory') || '[]'),
    TEMAS_DISPONIBLES: [
        'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
        'Polimorfismo', 'Clases Abstractas e Interfaces', 'UML', 'Diagramas UML',
        'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
        'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
    ]
};

// --- Utilidades Generales ---
// Manejo de errores en fetch
const handleFetchError = (error, context) => {
    console.error(`Error en ${context}:`, error);
    let message = 'Error inesperado';
    if (!navigator.onLine) message = 'Sin conexión a internet';
    else if (error.message.includes('503')) message = 'El servidor está ocupado, intenta de nuevo';
    else if (error.message.includes('429')) message = 'Demasiadas solicitudes, espera un momento';
    else if (error.message.includes('401')) message = 'No autorizado, verifica tu sesión';
    else if (error.message) message = error.message;
    mostrarNotificacion(`${context}: ${message}`, 'error');
    return null;
};

// Función debounce para optimizar eventos
const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

// Obtener elemento del DOM con logging
const getElement = selector => {
    const element = document.querySelector(selector);
    if (!element) console.warn(`Elemento ${selector} no encontrado en el DOM`);
    return element;
};

// Obtener múltiples elementos del DOM con logging
const getElements = selector => {
    const elements = document.querySelectorAll(selector);
    if (!elements.length) console.warn(`No se encontraron elementos para ${selector}`);
    return elements;
};

// --- Manejo de UI ---
// Scroll al final del chat
const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    const lastMessage = container.lastElementChild;
    if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
};

// Mostrar notificación
const mostrarNotificacion = (mensaje, tipo) => {
    const notificationCard = getElement('#notification-card');
    if (!notificationCard) return;
    notificationCard.innerHTML = `<p>${mensaje}</p><button onclick="this.parentElement.classList.remove('active')" aria-label="Cerrar notificación">Cerrar</button>`;
    notificationCard.classList.remove('info', 'success', 'error');
    notificationCard.classList.add(tipo, 'active');
    setTimeout(() => {
        notificationCard.classList.remove('active');
    }, 5000);
};

// Toggle hint de voz
const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) {
        console.error('Elemento #voice-hint no encontrado');
        return;
    }
    const now = Date.now();
    if (show && now - config.lastVoiceHintTime < 5000) return;
    voiceHint.classList.toggle('hidden', !show);
    if (show) config.lastVoiceHintTime = now;
};

// Actualizar display del avatar
const updateAvatarDisplay = () => {
    const avatarImg = getElement('#avatar-img');
    if (!avatarImg) {
        console.warn('Elemento #avatar-img no encontrado, omitiendo actualización');
        return;
    }
    const avatars = JSON.parse(localStorage.getItem('avatars') || '[]');
    const selected = avatars.find(a => a.avatar_id === config.selectedAvatar) || { url: '/static/img/default-avatar.png' };
    avatarImg.src = selected.url;
    avatarImg.classList.add('animate-avatar');
    setTimeout(() => avatarImg.classList.remove('animate-avatar'), 300);
};

// Mostrar loading en chat
const showLoading = () => {
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return null;
    const loadingDiv = document.createElement('div');
    loadingDiv.classList.add('loading');
    loadingDiv.innerHTML = '<div class="spinner"></div> Cargando...';
    container.appendChild(loadingDiv);
    scrollToBottom();
    return loadingDiv;
};

// Ocultar loading
const hideLoading = (loadingDiv) => {
    if (loadingDiv) loadingDiv.remove();
};

// Detectar si es móvil
const isMobile = () => window.innerWidth <= 768;

// --- Lógica de Audio y Voz ---
// Reproducir texto como audio
const speakText = async (text) => {
    console.log('Intentando reproducir audio:', { vozActiva: config.vozActiva, text, userHasInteracted: config.userHasInteracted });
    if (!config.vozActiva || !text) {
        console.warn('Audio desactivado o texto vacío', { vozActiva: config.vozActiva, text });
        mostrarNotificacion('Audio desactivado o texto vacío', 'error');
        return;
    }
    if (!config.userHasInteracted) {
        console.warn('No se puede reproducir audio: el usuario no ha interactuado');
        toggleVoiceHint(true);
        config.pendingWelcomeMessage = text;
        return;
    }
    const reemplazosTTS = {
        'POO': 'Programación Orientada a Objetos',
        'UML': 'U Em Ele',
        'MVC': 'Em Vi Ci',
        'ORM': 'Mapeo Objeto Relacional',
        'BD': 'Base de Datos',
        'API': 'A Pi I',
        'SQL': 'Esquiu Ele'
    };
    let textoParaVoz = text
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/#+\s*/g, '')
        .replace(/-\s*/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\b(POO|UML|MVC|ORM|BD)\b/g, match => reemplazosTTS[match] || match)
        .replace(/\bYELIA\b/g, 'Yelia')
        .trim();
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    if (config.currentAudio) {
        if (config.currentAudio instanceof Audio) {
            config.currentAudio.pause();
            config.currentAudio.currentTime = 0;
        } else if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        config.currentAudio = null;
    }
    try {
        console.log('Enviando solicitud al endpoint /tts');
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textoParaVoz })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Error en /tts: ${res.status} ${res.statusText}`);
        }
        const blob = await res.blob();
        config.currentAudio = new Audio(URL.createObjectURL(blob));
        config.currentAudio.play().catch(error => {
            console.error('Error al reproducir audio:', error);
            mostrarNotificacion('Error al reproducir audio: ' + error.message, 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        });
        config.currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
            config.currentAudio = null;
        };
    } catch (error) {
        console.error('Fallo en /tts, intentando speechSynthesis:', error);
        if ('speechSynthesis' in window) {
            let voices = speechSynthesis.getVoices();
            if (voices.length === 0) {
                // Forzar carga de voces si no están listas
                speechSynthesis.speak(new SpeechSynthesisUtterance(''));
                voices = speechSynthesis.getVoices();
            }
            const esVoice = voices.find(v => v.lang.includes('es') || v.lang.includes('es-ES') || v.lang.includes('es_MX'));
            if (!esVoice) {
                console.warn('No se encontró voz en español');
                mostrarNotificacion('No se encontró voz en español. Usando voz predeterminada.', 'warning');
                const defaultVoice = voices.find(v => v.default) || voices[0];
                if (!defaultVoice) {
                    console.error('No hay voces disponibles');
                    mostrarNotificacion('No hay voces disponibles en este navegador', 'error');
                    if (botMessage) botMessage.classList.remove('speaking');
                    return;
                }
                const utterance = new SpeechSynthesisUtterance(textoParaVoz);
                utterance.voice = defaultVoice;
                utterance.lang = defaultVoice.lang;
                utterance.pitch = 1;
                utterance.rate = 0.9;
                utterance.onend = () => {
                    if (botMessage) botMessage.classList.remove('speaking');
                    config.currentAudio = null;
                };
                utterance.onerror = (event) => {
                    console.error('Error en speechSynthesis:', event.error);
                    let errorMsg = 'Error en audio local: ' + event.error;
                    if (event.error === 'not-allowed') errorMsg = 'Audio no permitido, interactúa con la página primero';
                    if (event.error === 'network') errorMsg = 'Error de red en síntesis de voz';
                    mostrarNotificacion(errorMsg, 'error');
                    if (botMessage) botMessage.classList.remove('speaking');
                };
                speechSynthesis.speak(utterance);
                config.currentAudio = utterance;
                return;
            }
            const utterance = new SpeechSynthesisUtterance(textoParaVoz);
            utterance.lang = 'es-ES';
            utterance.voice = esVoice;
            utterance.pitch = 1;
            utterance.rate = 0.9;
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                config.currentAudio = null;
            };
            utterance.onerror = (event) => {
                console.error('Error en speechSynthesis:', event.error);
                let errorMsg = 'Error en audio local: ' + event.error;
                if (event.error === 'not-allowed') errorMsg = 'Audio no permitido, interactúa con la página primero';
                if (event.error === 'network') errorMsg = 'Error de red en síntesis de voz';
                mostrarNotificacion(errorMsg, 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            };
            speechSynthesis.speak(utterance);
            config.currentAudio = utterance;
        } else {
            console.warn('speechSynthesis no soportado');
            mostrarNotificacion('Audio no soportado en este navegador', 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

// Detener audio
const stopSpeech = () => {
    console.log('Deteniendo audio');
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    if (config.currentAudio instanceof Audio) {
        config.currentAudio.pause();
        config.currentAudio.currentTime = 0;
    }
    config.currentAudio = null;
    if (config.isListening && config.recognition) {
        config.recognition.stop();
        config.isListening = false;
        if (voiceToggleBtn) {
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        }
        mostrarNotificacion('Reconocimiento de voz detenido', 'info');
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

// Toggle reconocimiento de voz
const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) return;
    if (!config.isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado en este navegador', 'error');
            return;
        }
        config.recognition = ('webkitSpeechRecognition' in window) ? new webkitSpeechRecognition() : new SpeechRecognition();
        config.recognition.lang = 'es-ES';
        config.recognition.interimResults = true;
        config.recognition.continuous = true;
        let timeoutId = null;
        try {
            config.recognition.start();
            config.isListening = true;
            voiceToggleBtn.classList.add('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Detener Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Detener reconocimiento de voz');
            voiceToggleBtn.classList.add('pulse');
            mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        } catch (error) {
            console.error('Error al iniciar reconocimiento de voz:', error);
            mostrarNotificacion('Error al iniciar reconocimiento de voz', 'error');
            return;
        }
        const resetTimeout = () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                if (config.isListening) stopSpeech();
                mostrarNotificacion('Reconocimiento de voz detenido por inactividad', 'info');
            }, 15000);
        };
        resetTimeout();
        config.recognition.onresult = event => {
            resetTimeout();
            const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            const input = getElement('#input');
            if (input) input.value = transcript;
            if (event.results[event.results.length - 1].isFinal) {
                sendMessage();
                config.recognition.stop();
                config.isListening = false;
                clearTimeout(timeoutId);
                voiceToggleBtn.classList.remove('voice-active', 'pulse');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        config.recognition.onerror = event => {
            clearTimeout(timeoutId);
            let errorMsg = `Error en reconocimiento de voz: ${event.error}`;
            if (event.error === 'no-speech') errorMsg = 'No se detectó voz, intenta de nuevo';
            if (event.error === 'aborted') errorMsg = 'Reconocimiento de voz cancelado';
            if (event.error === 'network') errorMsg = 'Error de red en reconocimiento de voz';
            if (event.error === 'not-allowed') errorMsg = 'Permiso de micrófono denegado';
            mostrarNotificacion(errorMsg, 'error');
            config.recognition.stop();
            config.isListening = false;
            voiceToggleBtn.classList.remove('voice-active', 'pulse');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        config.recognition.onend = () => {
            if (config.isListening) {
                try {
                    config.recognition.start();
                    resetTimeout();
                } catch (error) {
                    console.error('Error al reiniciar reconocimiento de voz:', error);
                    config.isListening = false;
                    voiceToggleBtn.classList.remove('voice-active', 'pulse');
                    voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                    voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                    voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
                }
            } else {
                clearTimeout(timeoutId);
                voiceToggleBtn.classList.remove('voice-active', 'pulse');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
    } else {
        stopSpeech();
    }
};

// --- Lógica del Chat ---
// Obtener historial desde localStorage
const getHistorial = () => {
    try {
        const historial = JSON.parse(localStorage.getItem('historial') || '[]');
        return Array.isArray(historial) ? historial : [];
    } catch (error) {
        console.error('Error al obtener historial:', error);
        return [];
    }
};

// Mostrar mensaje de bienvenida
const mostrarMensajeBienvenida = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        mostrarNotificacion('Error: Contenedor de chat no encontrado', 'error');
        return;
    }

    const mensaje = '👋 ¡Hola! Soy YELIA, tu asistente de Programación Avanzada en Ingeniería en Telemática. ¿Qué quieres aprender hoy?';
    
    if (container.children.length === 0) {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje, { breaks: true, gfm: true }) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();

        if (config.vozActiva && config.userHasInteracted) {
            speakText(mensaje);
        } else if (config.vozActiva) {
            config.pendingWelcomeMessage = mensaje;
        }
    }
};

// Enviar mensaje al servidor
const sendMessage = async () => {
    const input = getElement('#input');
    if (!input) return;
    const pregunta = input.value.trim();
    if (!pregunta) return;
    input.value = '';

    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return;
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.innerHTML = pregunta + 
        `<button class="copy-btn" data-text="${pregunta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(userDiv);
    const loadingDiv = showLoading();
    scrollToBottom();

    // Asegurar que conv_id es válido
    if (!config.currentConvId) {
        console.warn('No hay conv_id, creando nueva conversación');
        try {
            const res = await fetch('/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (!res.ok) throw new Error(`Error al crear conversación: ${res.status} - ${await res.text()}`);
            const data = await res.json();
            config.currentConvId = data.id;
            localStorage.setItem('lastConvId', config.currentConvId);
            await cargarConversaciones();
        } catch (error) {
            handleFetchError(error, 'Creación de conversación');
            hideLoading(loadingDiv);
            return;
        }
    }

    try {
        await fetch(`/messages/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: "user", content: pregunta })
        });
    } catch (error) {
        handleFetchError(error, 'Guardado de mensaje usuario');
        hideLoading(loadingDiv);
        return;
    }

    const payload = {
        pregunta,
        historial: getHistorial(),
        nivel_explicacion: localStorage.getItem('nivelExplicacion') || 'basica',
        conv_id: config.currentConvId
    };
    console.log('Enviando a /buscar_respuesta:', payload);
    try {
        const res = await fetch('/buscar_respuesta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`Error al procesar la solicitud: ${res.status} - ${errorText}`);
        }
        const data = await res.json();
        if (!data.respuesta) {
            throw new Error('Respuesta vacía desde el servidor');
        }
        hideLoading(loadingDiv);

        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.respuesta);

        await fetch(`/messages/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: "bot", content: data.respuesta })
        });

        config.historial.push({ pregunta, respuesta: data.respuesta });
        if (config.historial.length > 10) config.historial.shift();
        localStorage.setItem('historial', JSON.stringify(config.historial));
    } catch (error) {
        handleFetchError(error, 'Envío de mensaje');
        hideLoading(loadingDiv);
    }
};

// Crear nueva conversación
const nuevaConversacion = async () => {
    try {
        const res = await fetch('/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        config.currentConvId = data.id;
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
        mostrarNotificacion('Nueva conversación iniciada', 'success');
    } catch (error) {
        handleFetchError(error, 'Creación de nueva conversación');
    }
};

// Vaciar chat actual
const vaciarChat = async () => {
    if (!config.currentConvId) return;
    await nuevaConversacion();
};

// --- Comunicación con el Servidor ---
// Cargar avatares
const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) return;
    try {
        const response = await fetch('/avatars', { cache: 'no-store' });
        let avatares = [];
        if (response.ok) {
            const data = await response.json();
            avatares = data.avatars || [];
        } else {
            avatares = [{ avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }];
        }
        localStorage.setItem('avatars', JSON.stringify(avatares));
        avatarContainer.innerHTML = '';
        avatares.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.classList.add('avatar-option');
            img.dataset.avatar = avatar.avatar_id;
            img.alt = `Avatar ${avatar.nombre}`;
            img.title = avatar.nombre;
            if (avatar.avatar_id === config.selectedAvatar) img.classList.add('selected');
            avatarContainer.appendChild(img);
            img.addEventListener('click', () => {
                getElements('.avatar-option').forEach(opt => opt.classList.remove('selected'));
                img.classList.add('selected');
                config.selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', config.selectedAvatar);
                updateAvatarDisplay();
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
        updateAvatarDisplay();
    } catch (error) {
        handleFetchError(error, 'Carga de avatares');
    }
};

// Cargar conversaciones
const cargarConversaciones = async () => {
    try {
        const res = await fetch('/conversations');
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();
        const chatList = getElement('#chat-list');
        if (!chatList) return;
        chatList.innerHTML = '';

        data.conversations.forEach(conv => {
            const li = document.createElement('li');
            li.dataset.id = conv.id;
            li.innerHTML = `
                <span class="chat-name">${conv.nombre}</span>
                <div class="chat-actions">
                    <button class="rename-btn" data-tooltip="Renombrar"><i class="fas fa-edit"></i></button>
                    <button class="delete-btn" data-tooltip="Eliminar"><i class="fas fa-trash"></i></button>
                </div>
            `;
            li.addEventListener('click', () => {
                config.currentConvId = conv.id;
                localStorage.setItem('lastConvId', config.currentConvId);
                cargarMensajes(conv.id);
            });
            chatList.appendChild(li);

            li.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                eliminarConversacion(conv.id);
            });
            li.querySelector('.rename-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                renombrarConversacion(conv.id);
            });
        });

        if (data.conversations.length > 0 && !config.currentConvId) {
            const lastConvId = localStorage.getItem('lastConvId');
            if (lastConvId) {
                config.currentConvId = parseInt(lastConvId);
                if (!isNaN(config.currentConvId)) {
                    cargarMensajes(config.currentConvId);
                }
            } else {
                config.currentConvId = data.conversations[0].id;
                cargarMensajes(config.currentConvId);
                localStorage.setItem('lastConvId', config.currentConvId);
            }
        } else if (data.conversations.length === 0) {
            mostrarMensajeBienvenida();
        }
    } catch (error) {
        handleFetchError(error, 'Carga de conversaciones');
    }
};

// Cargar mensajes de una conversación
const cargarMensajes = async (convId) => {
    if (!convId) {
        console.warn("⚠️ No hay convId válido, no se pueden cargar mensajes.");
        return;
    }
    config.currentConvId = convId;

    try {
        const res = await fetch(`/messages/${convId}`);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();

        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) return;
        container.innerHTML = '';

        data.messages.forEach(msg => {
            const div = document.createElement('div');
            div.classList.add(msg.role === 'user' ? 'user' : 'bot');
            div.innerHTML = (typeof marked !== 'undefined' ? marked.parse(msg.content) : msg.content) +
                `<button class="copy-btn" data-text="${msg.content.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(div);
        });

        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
    } catch (error) {
        handleFetchError(error, 'Carga de mensajes');
    }
};

// Eliminar conversación
const eliminarConversacion = async (convId) => {
    if (!confirm("¿Estás seguro de que quieres eliminar esta conversación?")) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            if (config.currentConvId === convId) {
                config.currentConvId = null;
                const container = getElement('#chatbox')?.querySelector('.message-container');
                if (container) container.innerHTML = '';
                mostrarMensajeBienvenida();
            }
            cargarConversaciones();
            mostrarNotificacion('Conversación eliminada', 'success');
        } else {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Error al eliminar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Eliminación de conversación');
    }
};

// Renombrar conversación
const renombrarConversacion = async (convId) => {
    const nuevoNombre = prompt('Nuevo nombre para la conversación:');
    if (!nuevoNombre) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nuevoNombre })
        });
        if (res.ok) {
            cargarConversaciones();
            mostrarNotificacion('Conversación renombrada', 'success');
        } else {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Error al renombrar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Renombrar conversación');
    }
};

// Cargar temas
const cargarTemas = async () => {
    const cacheKey = 'temasCache';
    const cacheTimeKey = 'temasCacheTime';
    const cacheDuration = 24 * 60 * 60 * 1000;
    const cachedTemas = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);

    if (cachedTemas && cachedTime && Date.now() - parseInt(cachedTime) < cacheDuration) {
        config.TEMAS_DISPONIBLES = JSON.parse(cachedTemas);
        console.log('Temas cargados desde caché:', config.TEMAS_DISPONIBLES);
        return;
    }

    try {
        const res = await fetch('/temas', { method: 'GET' });
        if (!res.ok) throw new Error(`Error al cargar temas: ${res.status}`);
        const data = await res.json();
        if (data.temas && Array.isArray(data.temas)) {
            config.TEMAS_DISPONIBLES = data.temas;
            localStorage.setItem(cacheKey, JSON.stringify(config.TEMAS_DISPONIBLES));
            localStorage.setItem(cacheTimeKey, Date.now().toString());
            console.log('Temas cargados desde servidor:', config.TEMAS_DISPONIBLES);
        } else {
            console.warn('No se pudieron cargar temas, usando lista por defecto');
        }
    } catch (error) {
        handleFetchError(error, 'Carga de temas');
        console.warn('Usando temas por defecto debido a error');
    }
};

// Obtener quiz
const obtenerQuiz = async (tipo) => {
    console.log('Obteniendo quiz, tipo:', tipo);
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', nivel: localStorage.getItem('nivelExplicacion') || 'basica' })
        });
        if (!res.ok) throw new Error(`Error al obtener quiz: ${res.status}`);
        const data = await res.json();
        config.quizHistory.push(data);
        localStorage.setItem('quizHistory', JSON.stringify(config.quizHistory));
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Obtención de quiz');
        hideLoading(loadingDiv);
        return null;
    }
};

// Mostrar quiz en chat
const mostrarQuizEnChat = async (quizData) => {
    if (!quizData) return;
    console.log('Mostrando quiz en chat:', quizData);
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return;
    const quizDiv = document.createElement('div');
    quizDiv.classList.add('bot');
    quizDiv.setAttribute('aria-live', 'polite');
    let optionsHtml = quizData.opciones.map((opcion, index) => `
        <div class="quiz-option" data-option="${opcion}" data-index="${index}" tabindex="0" role="button" aria-label="Opción ${opcion}">${opcion}</div>
    `).join('');
    quizDiv.innerHTML = `
        <p>${quizData.pregunta}</p>
        <div class="quiz-options">${optionsHtml}</div>
        <button class="copy-btn" data-text="${quizData.pregunta}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>
    `;
    quizDiv.dataset.respuestaCorrecta = quizData.respuesta_correcta || '';
    quizDiv.dataset.tema = quizData.tema || 'unknown';
    container.appendChild(quizDiv);
    scrollToBottom();

    getElements('.quiz-option').forEach(option => {
        option.removeEventListener('click', handleQuizOption);
        option.addEventListener('click', handleQuizOption);
        option.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                option.click();
            }
        });
    });
    addCopyButtonListeners();
};

// Manejar selección de opción en quiz
const handleQuizOption = async (event) => {
    const option = event.currentTarget;
    const selectedOption = option.dataset.option;
    const quizContainer = option.closest('.bot');
    const quizData = {
        pregunta: quizContainer.querySelector('p').textContent,
        opciones: Array.from(quizContainer.querySelectorAll('.quiz-option')).map(opt => opt.dataset.option),
        respuesta_correcta: quizContainer.dataset.respuestaCorrecta || '',
        tema: quizContainer.dataset.tema || 'unknown'
    };
    if (!quizData.respuesta_correcta) {
        console.error('No se proporcionó respuesta_correcta');
        mostrarNotificacion('Error: No se pudo determinar la respuesta correcta', 'error');
        return;
    }
    getElements('.quiz-option').forEach(opt => {
        opt.classList.remove('selected', 'correct', 'incorrect');
        opt.style.pointerEvents = 'none';
    });
    option.classList.add('selected');
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/responder_quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pregunta: quizData.pregunta,
                respuesta: selectedOption,
                respuesta_correcta: quizData.respuesta_correcta,
                tema: quizData.tema
            })
        });
        if (!res.ok) throw new Error(`Error al responder quiz: ${res.status} - ${await res.text()}`);
        const data = await res.json();
        if (!data.hasOwnProperty('es_correcta') || !data.explicacion) {
            throw new Error('Respuesta del servidor incompleta');
        }
        const isCorrect = data.es_correcta;
        option.classList.add(isCorrect ? 'correct' : 'incorrect');
        if (!isCorrect) {
            const correctOption = quizContainer.querySelector(`.quiz-option[data-option="${quizData.respuesta_correcta}"]`);
            if (correctOption) correctOption.classList.add('correct');
        }
        hideLoading(loadingDiv);
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) return;

        // Generar mensaje de retroalimentación
        let feedbackMessage = '';
        if (isCorrect) {
            feedbackMessage = `¡Felicidades! Seleccionaste la opción correcta: "${selectedOption}". ${data.explicacion || 'Esta es la respuesta correcta porque aborda el objetivo principal del tema.'}`;
        } else {
            feedbackMessage = `Incorrecto. Seleccionaste: "${selectedOption}". La opción correcta es: "${quizData.respuesta_correcta}". ${data.explicacion || 'La respuesta correcta es la que mejor representa el concepto evaluado.'}`;
        }

        const feedbackDiv = document.createElement('div');
        feedbackDiv.classList.add('bot');
        feedbackDiv.innerHTML = `
            <span class="quiz-feedback ${isCorrect ? 'correct' : 'incorrect'}">
                ${isCorrect ? '<i class="fas fa-check-circle"></i> ¡Correcto!' : '<i class="fas fa-times-circle"></i> Incorrecto'}
            </span>
            <p>${feedbackMessage}</p>
            <button class="copy-btn" data-text="${feedbackMessage}" aria-label="Copiar explicación"><i class="fas fa-copy"></i></button>
        `;
        container.appendChild(feedbackDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(feedbackMessage);

        // Guardar en historial
        config.historial.push({ 
            pregunta: quizData.pregunta, 
            respuesta: feedbackMessage, 
            tema: quizData.tema,
            es_correcta: isCorrect,
            opcion_seleccionada: selectedOption
        });
        if (config.historial.length > 10) config.historial.shift();
        localStorage.setItem('historial', JSON.stringify(config.historial));

        // Guardar en el servidor
        if (config.currentConvId) {
            await fetch(`/messages/${config.currentConvId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    role: "bot", 
                    content: feedbackMessage, 
                    tema: quizData.tema,
                    metadata: { es_correcta: isCorrect, opcion_seleccionada: selectedOption }
                })
            });
        }
    } catch (error) {
        handleFetchError(error, 'Respuesta de quiz');
        hideLoading(loadingDiv);
    }
};

// Obtener recomendación
const obtenerRecomendacion = async () => {
    console.log('Obteniendo recomendación');
    const loadingDiv = showLoading();
    try {
        const res = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: getHistorial() })
        });
        if (!res.ok) throw new Error(`Error al obtener recomendación: ${res.status}`);
        const data = await res.json();
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Obtención de recomendación');
        hideLoading(loadingDiv);
        return { recommendation: 'No se pudo generar recomendación' };
    }
};

// --- Eventos y Inicialización ---
// Toggle menú desplegable
const toggleDropdown = (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (!dropdownMenu) {
        console.error('Elemento .dropdown-menu no encontrado');
        mostrarNotificacion('Error: Menú de niveles no encontrado', 'error');
        return;
    }
    dropdownMenu.classList.toggle('active');
    console.log('Menú desplegable toggled:', dropdownMenu.classList.contains('active') ? 'abierto' : 'cerrado');
    if (event) event.stopPropagation();
};

// Setear nivel de explicación
const setNivelExplicacion = (nivel) => {
    console.log('setNivelExplicacion llamado con nivel:', nivel);
    if (!['basica', 'ejemplos', 'avanzada'].includes(nivel)) {
        console.error('Nivel inválido:', nivel);
        mostrarNotificacion('Error: Nivel inválido', 'error');
        return;
    }

    localStorage.setItem('nivelExplicacion', nivel);
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        const nivelText =
            nivel === 'basica' ? 'Explicación Básica' :
            nivel === 'ejemplos' ? 'Con Ejemplos de Código' :
            'Avanzada/Teórica';
        nivelBtn.innerHTML = `${nivelText} <i class="fas fa-caret-down"></i>`;
        console.log('Nivel actualizado a:', nivelText);

        const dropdownMenu = getElement('.dropdown-menu');
        if (dropdownMenu && dropdownMenu.classList.contains('active')) {
            dropdownMenu.classList.remove('active');
            console.log('Menú desplegable cerrado tras seleccionar nivel');
        }

        mostrarNotificacion(`Nivel cambiado a: ${nivelText}`, 'success');
    } else {
        console.error('Elemento #nivel-btn no encontrado');
        mostrarNotificacion('Error: Botón de nivel no encontrado', 'error');
    }
};

// Toggle menú izquierdo
const toggleMenu = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    if (!leftSection) return;
    leftSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggle = getElement('.menu-toggle');
        if (menuToggle) {
            menuToggle.innerHTML = leftSection.classList.contains('active')
                ? '<i class="fas fa-times"></i>'
                : '<i class="fas fa-bars"></i>';
        }
    }

    if (rightSection && rightSection.classList.contains('active')) {
        rightSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && leftSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

// Toggle menú derecho
const toggleRightMenu = () => {
    const rightSection = getElement('.right-section');
    const leftSection = getElement('.left-section');
    if (!rightSection) return;
    rightSection.classList.toggle('active');

    if (isMobile()) {
        const menuToggleRight = getElement('.menu-toggle-right');
        if (menuToggleRight) {
            menuToggleRight.innerHTML = rightSection.classList.contains('active')
                ? '<i class="fas fa-times"></i>'
                : '<i class="fas fa-bars"></i>';
        }
    }

    if (leftSection && leftSection.classList.contains('active')) {
        leftSection.classList.remove('active');
    }

    const voiceHint = getElement('#voice-hint');
    if (voiceHint && rightSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

// Toggle modo oscuro
const toggleDarkMode = () => {
    document.body.classList.toggle('modo-oscuro');
    const isModoOscuro = document.body.classList.contains('modo-oscuro');
    localStorage.setItem('modoOscuro', isModoOscuro);
    const modoBtn = getElement('#modo-btn');
    if (modoBtn) {
        modoBtn.setAttribute('data-tooltip', isModoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
        modoBtn.setAttribute('aria-label', isModoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
        modoBtn.innerHTML = `
            <i class="fas ${isModoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${isModoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
        `;
    }
    mostrarNotificacion(`Modo ${isModoOscuro ? 'oscuro' : 'claro'} activado`, 'success');
};

// Toggle voz
const handleVoiceToggle = () => {
    config.vozActiva = !config.vozActiva;
    localStorage.setItem('vozActiva', config.vozActiva);
    const voiceBtn = getElement('#voice-btn');
    if (voiceBtn) {
        voiceBtn.innerHTML = `
            <i class="fas ${config.vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${config.vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
        `;
        voiceBtn.setAttribute('data-tooltip', config.vozActiva ? 'Desactivar Audio' : 'Activar Audio');
        voiceBtn.setAttribute('aria-label', config.vozActiva ? 'Desactivar audio' : 'Activar audio');
    }
    mostrarNotificacion(`Audio ${config.vozActiva ? 'activado' : 'desactivado'}`, 'success');
    if (!config.vozActiva) stopSpeech();
    if (config.vozActiva && !config.userHasInteracted) toggleVoiceHint(true);
};

// Manejar clic en quiz
const handleQuizClick = async () => {
    console.log('Botón de quiz clickeado');
    const quiz = await obtenerQuiz('opciones');
    if (quiz) mostrarQuizEnChat(quiz);
};

// Manejar clic en recomendación
const handleRecommendClick = async () => {
    console.log('Botón de recomendación clickeado');
    const data = await obtenerRecomendacion();
    const mensaje = data.recommendation;
    if (!mensaje) {
        mostrarNotificacion('No se pudo obtener recomendación', 'error');
        return;
    }
    const tema = mensaje.match(/Te recomiendo estudiar: (.*)/)?.[1] || 'unknown';
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) return;
    const botDiv = document.createElement('div');
    botDiv.classList.add('bot');
    botDiv.dataset.tema = tema;
    botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
        `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(botDiv);
    scrollToBottom();
    if (window.Prism) Prism.highlightAll();
    speakText(mensaje);
    addCopyButtonListeners();

    config.historial.push({ pregunta: '', respuesta: mensaje, tema });
    if (config.historial.length > 10) config.historial.shift();
    localStorage.setItem('historial', JSON.stringify(config.historial));

    if (config.currentConvId) {
        await fetch(`/messages/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'bot', content: mensaje, tema })
        });
    }
};

// Manejar tecla enter en input
const handleInputKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
};

// Manejar primera interacción del usuario
const handleFirstInteraction = () => {
    if (!config.userHasInteracted) {
        config.userHasInteracted = true;
        toggleVoiceHint(false);
        if (config.pendingWelcomeMessage) {
            speakText(config.pendingWelcomeMessage);
            config.pendingWelcomeMessage = null;
        }
    }
};

// Añadir listeners a botones de copia
const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', handleCopy);
        btn.addEventListener('click', handleCopy);
    });
};

// Manejar copia de texto
const handleCopy = (event) => {
    const btn = event.currentTarget;
    const text = btn.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
        mostrarNotificacion('Texto copiado al portapapeles', 'success');
        btn.innerHTML = `<i class="fas fa-check"></i>`;
        setTimeout(() => btn.innerHTML = `<i class="fas fa-copy"></i>`, 2000);
    }).catch(err => {
        console.error('Error al copiar texto:', err);
        mostrarNotificacion('Error al copiar texto', 'error');
    });
};

// Inicialización de la aplicación
const init = () => {
    console.log('Inicializando aplicación');
    const modoOscuro = localStorage.getItem('modoOscuro') === 'true';
    if (modoOscuro) document.body.classList.add('modo-oscuro');

    const nivel = localStorage.getItem('nivelExplicacion') || 'basica';
    setNivelExplicacion(nivel);

    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) {
        dropdownMenu.innerHTML = `
            <button onclick="setNivelExplicacion('basica')">Explicación Básica</button>
            <button onclick="setNivelExplicacion('ejemplos')">Con Ejemplos de Código</button>
            <button onclick="setNivelExplicacion('avanzada')">Avanzada/Teórica</button>
        `;
    }

    const menuToggle = getElement('.menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', toggleMenu);
        menuToggle.setAttribute('data-tooltip', 'Menú Izquierdo');
        menuToggle.setAttribute('aria-label', 'Abrir menú izquierdo');
    }

    const menuToggleRight = getElement('.menu-toggle-right');
    if (menuToggleRight) {
        menuToggleRight.addEventListener('click', toggleRightMenu);
        menuToggleRight.setAttribute('data-tooltip', 'Menú Derecho');
        menuToggleRight.setAttribute('aria-label', 'Abrir menú derecho');
    }

    const modoBtn = getElement('#modo-btn');
    if (modoBtn) {
        modoBtn.addEventListener('click', toggleDarkMode);
        modoBtn.setAttribute('data-tooltip', modoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
        modoBtn.setAttribute('aria-label', modoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
        modoBtn.innerHTML = `
            <i class="fas ${modoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${modoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
        `;
    }

    const voiceBtn = getElement('#voice-btn');
    if (voiceBtn) {
        voiceBtn.addEventListener('click', handleVoiceToggle);
        voiceBtn.setAttribute('data-tooltip', config.vozActiva ? 'Desactivar Audio' : 'Activar Audio');
        voiceBtn.setAttribute('aria-label', config.vozActiva ? 'Desactivar audio' : 'Activar audio');
        voiceBtn.innerHTML = `
            <i class="fas ${config.vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${config.vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
        `;
    }

    const quizBtn = getElement('#quiz-btn');
    if (quizBtn) {
        quizBtn.addEventListener('click', handleQuizClick);
        quizBtn.setAttribute('data-tooltip', 'Obtener Quiz');
        quizBtn.setAttribute('aria-label', 'Generar un quiz');
    }

    const recommendBtn = getElement('#recommend-btn');
    if (recommendBtn) {
        recommendBtn.addEventListener('click', handleRecommendClick);
        recommendBtn.setAttribute('data-tooltip', 'Obtener Recomendación');
        recommendBtn.setAttribute('aria-label', 'Obtener recomendación de tema');
    }

    const sendBtn = getElement('#send-btn');
    if (sendBtn) {
        sendBtn.addEventListener('click', sendMessage);
        sendBtn.setAttribute('data-tooltip', 'Enviar');
        sendBtn.setAttribute('aria-label', 'Enviar mensaje');
    }

    const newChatBtn = getElement('#new-chat-btn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', nuevaConversacion);
        newChatBtn.setAttribute('data-tooltip', 'Nuevo Chat');
        newChatBtn.setAttribute('aria-label', 'Iniciar nueva conversación');
    }

    const clearBtn = getElement('#btn-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', vaciarChat);
        clearBtn.setAttribute('data-tooltip', 'Limpiar Chat');
        clearBtn.setAttribute('aria-label', 'Limpiar chat actual');
    }

    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        nivelBtn.addEventListener('click', toggleDropdown);
        nivelBtn.setAttribute('data-tooltip', 'Cambiar Nivel');
        nivelBtn.setAttribute('aria-label', 'Cambiar nivel de explicación');
    }

    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (voiceToggleBtn) {
        voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
        voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
    }

    const input = getElement('#input');
    if (input) {
        input.addEventListener('keydown', handleInputKeydown);
    }

    document.addEventListener('click', handleFirstInteraction, { once: true });
    document.addEventListener('touchstart', handleFirstInteraction, { once: true });

    cargarTemas();
    cargarAvatares();
    cargarConversaciones();
    addCopyButtonListeners();

    window.addEventListener('resize', debounce(() => {
        if (!isMobile()) {
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (leftSection) leftSection.classList.remove('active');
            if (rightSection) rightSection.classList.remove('active');
        }
    }, 250));

    setTimeout(() => {
        mostrarMensajeBienvenida();
        if (config.vozActiva && !config.userHasInteracted) toggleVoiceHint(true);
    }, 100);

    // Precargar voces para speechSynthesis
    if ('speechSynthesis' in window) {
        speechSynthesis.onvoiceschanged = () => {
            speechSynthesis.getVoices();
        };
        // Forzar carga inicial
        speechSynthesis.getVoices();
    }
};

// Evento para cerrar menús al clicar fuera
document.addEventListener('click', (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    const nivelBtn = getElement('#nivel-btn');

    if (nivelBtn && nivelBtn.contains(event.target)) {
        console.log('Clic en botón de nivel, toggling menú');
        return;
    }

    if (dropdownMenu && dropdownMenu.contains(event.target)) {
        console.log('Clic en opción del menú desplegable');
        return;
    }

    if (dropdownMenu && dropdownMenu.classList.contains('active')) {
        dropdownMenu.classList.remove('active');
        console.log('Menú desplegable cerrado por clic fuera');
    }

    if (isMobile()) {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');

        if (leftSection && leftSection.classList.contains('active') &&
            !leftSection.contains(event.target) &&
            !getElement('.menu-toggle').contains(event.target)) {
            toggleMenu();
        }

        if (rightSection && rightSection.classList.contains('active') &&
            !rightSection.contains(event.target) &&
            !getElement('.menu-toggle-right').contains(event.target)) {
            toggleRightMenu();
        }
    }
});

// Inicializar al cargar DOM
document.addEventListener('DOMContentLoaded', init);
