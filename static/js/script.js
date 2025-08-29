// script.js - Refactorizado para alinearse con app.py
// Soporte para logout, manejo robusto de conv_id, y consistencia con endpoints.

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
    currentConvId: localStorage.getItem('lastConvId') || null,
    historial: JSON.parse(localStorage.getItem('historial') || '[]'),
    quizHistory: JSON.parse(localStorage.getItem('quizHistory') || '[]'),
    nivelExplicacion: localStorage.getItem('nivelExplicacion') || 'basica',
    temaSeleccionado: null,
    API_URL: '/buscar_respuesta',
    QUIZ_URL: '/quiz',
    TTS_URL: '/tts',
    RECOMMEND_URL: '/recommend',
    CONVERSATIONS_URL: '/conversations',
    MESSAGES_URL: '/messages',
    AVATARS_URL: '/avatars',
    TEMAS_URL: '/temas',
    LOGOUT_URL: '/logout',
    TEMAS_DISPONIBLES: []
};

// --- Utilidades Generales ---
const handleFetchError = (error, context) => {
    console.error(`Error en ${context}:`, error);
    let message = 'Error inesperado';
    if (!navigator.onLine) message = 'Sin conexión a internet';
    else if (error.message.includes('503')) message = 'El servidor está ocupado, intenta de nuevo';
    else if (error.message.includes('429')) message = 'Demasiadas solicitudes, espera un momento';
    else if (error.message.includes('401') || error.message.includes('404')) message = 'No autorizado, verifica tu sesión';
    else if (error.message) message = error.message;
    mostrarNotificacion(`${context}: ${message}`, 'error');
    return null;
};

const debounce = (func, wait) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

const getElement = selector => {
    const element = document.querySelector(selector);
    if (!element) console.warn(`Elemento ${selector} no encontrado en el DOM`);
    return element;
};

const getElements = selector => {
    const elements = document.querySelectorAll(selector);
    if (!elements.length) console.warn(`No se encontraron elementos para ${selector}`);
    return elements;
};

// --- Manejo de UI ---
const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    const lastMessage = container.lastElementChild;
    if (lastMessage) {
        lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
};

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

const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) return;
    const now = Date.now();
    if (show && now - config.lastVoiceHintTime < 5000) return;
    voiceHint.classList.toggle('hidden', !show);
    if (show) config.lastVoiceHintTime = now;
};

const updateAvatarDisplay = () => {
    const avatarImg = getElement('#avatar-img');
    if (!avatarImg) return;
    const avatars = JSON.parse(localStorage.getItem('avatars') || '[]');
    const selected = avatars.find(a => a.avatar_id === config.selectedAvatar) || { url: '/static/favicon.ico' };
    avatarImg.src = selected.url;
    avatarImg.classList.add('animate-avatar');
    setTimeout(() => avatarImg.classList.remove('animate-avatar'), 300);
};

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

const hideLoading = (loadingDiv) => {
    if (loadingDiv) loadingDiv.remove();
};

const isMobile = () => window.innerWidth <= 768;

// --- Lógica de Audio y Voz ---
const speakText = async (text) => {
    if (!config.vozActiva || !text) {
        mostrarNotificacion('Audio desactivado o texto vacío', 'error');
        return;
    }
    if (!config.userHasInteracted) {
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
        .replace(/\b(POO|UML|MVC|ORM|BD|API|SQL)\b/g, match => reemplazosTTS[match] || match)
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
        const res = await fetch(config.TTS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textoParaVoz })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Error en /tts: ${res.status}`);
        }
        const blob = await res.blob();
        config.currentAudio = new Audio(URL.createObjectURL(blob));
        config.currentAudio.play().catch(error => {
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
                speechSynthesis.speak(new SpeechSynthesisUtterance(''));
                voices = speechSynthesis.getVoices();
            }
            const esVoice = voices.find(v => v.lang.includes('es') || v.lang.includes('es-ES') || v.lang.includes('es_MX'));
            const utterance = new SpeechSynthesisUtterance(textoParaVoz);
            utterance.lang = 'es-ES';
            utterance.voice = esVoice || voices.find(v => v.default) || voices[0];
            utterance.pitch = 1;
            utterance.rate = 0.9;
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                config.currentAudio = null;
            };
            utterance.onerror = (event) => {
                let errorMsg = 'Error en audio local: ' + event.error;
                if (event.error === 'not-allowed') errorMsg = 'Audio no permitido, interactúa con la página';
                mostrarNotificacion(errorMsg, 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            };
            speechSynthesis.speak(utterance);
            config.currentAudio = utterance;
        } else {
            mostrarNotificacion('Audio no soportado en este navegador', 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

const stopSpeech = () => {
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

const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) return;
    if (!config.isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado', 'error');
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
            mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        } catch (error) {
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
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        config.recognition.onerror = event => {
            clearTimeout(timeoutId);
            let errorMsg = `Error en reconocimiento de voz: ${event.error}`;
            if (event.error === 'no-speech') errorMsg = 'No se detectó voz, intenta de nuevo';
            mostrarNotificacion(errorMsg, 'error');
            config.recognition.stop();
            config.isListening = false;
            voiceToggleBtn.classList.remove('voice-active');
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
                    config.isListening = false;
                    voiceToggleBtn.classList.remove('voice-active');
                    voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                    voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                    voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
                }
            }
        };
    } else {
        stopSpeech();
    }
};

// --- Lógica del Chat ---
const getHistorial = () => {
    try {
        const historial = JSON.parse(localStorage.getItem('historial') || '[]');
        return Array.isArray(historial) ? historial : [];
    } catch (error) {
        return [];
    }
};

const mostrarMensajeBienvenida = async () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) return;

    // Evitar duplicar mensaje si ya existe una conversación
    if (container.children.length > 0) return;

    try {
        const res = await fetch(config.CONVERSATIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        config.currentConvId = data.id;
        localStorage.setItem('lastConvId', config.currentConvId);
        const mensaje = data.mensaje;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        if (config.vozActiva && config.userHasInteracted) {
            speakText(mensaje);
        } else if (config.vozActiva) {
            config.pendingWelcomeMessage = mensaje;
        }
        await cargarConversaciones();
    } catch (error) {
        handleFetchError(error, 'Carga de mensaje de bienvenida');
    }
};

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

    if (!config.currentConvId) {
        try {
            const res = await fetch(config.CONVERSATIONS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            if (!res.ok) throw new Error(`Error al crear conversación: ${res.status}`);
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
        await fetch(`${config.MESSAGES_URL}/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', content: pregunta })
        });

        const payload = {
            pregunta,
            historial: getHistorial(),
            nivel_explicacion: config.nivelExplicacion,
            conv_id: config.currentConvId
        };
        const res = await fetch(config.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`Error al procesar la solicitud: ${res.status} - ${await res.text()}`);
        const data = await res.json();
        if (!data.respuesta) throw new Error('Respuesta vacía desde el servidor');
        config.currentConvId = data.conv_id;
        localStorage.setItem('lastConvId', config.currentConvId);
        hideLoading(loadingDiv);

        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.respuesta);

        await fetch(`${config.MESSAGES_URL}/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'bot', content: data.respuesta })
        });

        config.historial.push({ pregunta, respuesta: data.respuesta });
        if (config.historial.length > 10) config.historial.shift();
        localStorage.setItem('historial', JSON.stringify(config.historial));
    } catch (error) {
        handleFetchError(error, 'Envío de mensaje');
        hideLoading(loadingDiv);
    }
};

const nuevaConversacion = async () => {
    try {
        const res = await fetch(config.CONVERSATIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        config.currentConvId = data.id;
        localStorage.setItem('lastConvId', config.currentConvId);
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
        mostrarNotificacion('Nueva conversación iniciada', 'success');
    } catch (error) {
        handleFetchError(error, 'Creación de nueva conversación');
    }
};

const cerrarSesion = async () => {
    try {
        const res = await fetch(config.LOGOUT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok) throw new Error(`Error al cerrar sesión: ${res.status}`);
        const data = await res.json();
        config.currentConvId = null;
        config.historial = [];
        config.quizHistory = [];
        localStorage.removeItem('lastConvId');
        localStorage.removeItem('historial');
        localStorage.removeItem('quizHistory');
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
        mostrarNotificacion(data.message, 'success');
    } catch (error) {
        handleFetchError(error, 'Cerrar sesión');
    }
};

const vaciarChat = async () => {
    if (!config.currentConvId) return;
    await nuevaConversacion();
};

// --- Comunicación con el Servidor ---
const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) return;
    try {
        const response = await fetch(config.AVATARS_URL, { cache: 'no-store' });
        let avatares = [];
        if (response.ok) {
            const data = await response.json();
            avatares = data.avatars || [];
        } else {
            avatares = [{ avatar_id: 'default', nombre: 'Default', url: '/static/favicon.ico', animation_url: '' }];
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

const cargarConversaciones = async () => {
    try {
        const res = await fetch(config.CONVERSATIONS_URL);
        if (!res.ok) throw new Error(`Error HTTP ${res.status}: ${await res.text()}`);
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
            config.currentConvId = data.conversations[0].id;
            localStorage.setItem('lastConvId', config.currentConvId);
            cargarMensajes(config.currentConvId);
        } else if (data.conversations.length === 0) {
            mostrarMensajeBienvenida();
        }
    } catch (error) {
        handleFetchError(error, 'Carga de conversaciones');
    }
};

const cargarMensajes = async (convId) => {
    if (!convId) return;
    config.currentConvId = convId;
    localStorage.setItem('lastConvId', convId);
    try {
        const res = await fetch(`${config.MESSAGES_URL}/${convId}`);
        if (!res.ok) throw new Error(`Error HTTP ${res.status}: ${await res.text()}`);
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

const eliminarConversacion = async (convId) => {
    if (!confirm("¿Estás seguro de que quieres eliminar esta conversación?")) return;
    try {
        const res = await fetch(`${config.CONVERSATIONS_URL}/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            if (config.currentConvId === convId) {
                config.currentConvId = null;
                localStorage.removeItem('lastConvId');
                const container = getElement('#chatbox')?.querySelector('.message-container');
                if (container) container.innerHTML = '';
                mostrarMensajeBienvenida();
            }
            cargarConversaciones();
            mostrarNotificacion('Conversación eliminada', 'success');
        } else {
            throw new Error((await res.json()).error || 'Error al eliminar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Eliminación de conversación');
    }
};

const renombrarConversacion = async (convId) => {
    const nuevoNombre = prompt('Nuevo nombre para la conversación:');
    if (!nuevoNombre) return;
    try {
        const res = await fetch(`${config.CONVERSATIONS_URL}/${convId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre: nuevoNombre })
        });
        if (res.ok) {
            cargarConversaciones();
            mostrarNotificacion('Conversación renombrada', 'success');
        } else {
            throw new Error((await res.json()).error || 'Error al renombrar conversación');
        }
    } catch (error) {
        handleFetchError(error, 'Renombrar conversación');
    }
};

const cargarTemas = async () => {
    const cacheKey = 'temasCache';
    const cacheTimeKey = 'temasCacheTime';
    const cacheDuration = 24 * 60 * 60 * 1000;
    const cachedTemas = localStorage.getItem(cacheKey);
    const cachedTime = localStorage.getItem(cacheTimeKey);

    if (cachedTemas && cachedTime && Date.now() - parseInt(cachedTime) < cacheDuration) {
        config.TEMAS_DISPONIBLES = JSON.parse(cachedTemas);
        actualizarSelectTemas();
        return;
    }

    try {
        const res = await fetch(config.TEMAS_URL, { method: 'GET' });
        if (!res.ok) throw new Error(`Error al cargar temas: ${res.status}`);
        const data = await res.json();
        if (data.temas && Array.isArray(data.temas)) {
            config.TEMAS_DISPONIBLES = data.temas;
            localStorage.setItem(cacheKey, JSON.stringify(config.TEMAS_DISPONIBLES));
            localStorage.setItem(cacheTimeKey, Date.now().toString());
            actualizarSelectTemas();
        }
    } catch (error) {
        handleFetchError(error, 'Carga de temas');
    }
};

const actualizarSelectTemas = () => {
    const temaSelect = getElement('#temaSelect');
    if (!temaSelect) return;
    temaSelect.innerHTML = '<option value="">Selecciona un tema</option>';
    config.TEMAS_DISPONIBLES.forEach(tema => {
        const option = document.createElement('option');
        option.value = tema;
        option.textContent = tema;
        temaSelect.appendChild(option);
    });
    temaSelect.addEventListener('change', () => {
        config.temaSeleccionado = temaSelect.value || null;
    });
};

const obtenerQuiz = async () => {
    const loadingDiv = showLoading();
    try {
        const res = await fetch(config.QUIZ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario: 'anonimo',
                nivel: config.nivelExplicacion,
                tema: config.temaSeleccionado,
                historial: getHistorial()
            })
        });
        if (!res.ok) throw new Error(`Error al obtener quiz: ${res.status} - ${await res.text()}`);
        const data = await res.json();
        config.currentConvId = data.conv_id;
        localStorage.setItem('lastConvId', config.currentConvId);
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

const mostrarQuizEnChat = async (quizData) => {
    if (!quizData) return;
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
    quizDiv.dataset.tema = quizData.tema || 'General';
    container.appendChild(quizDiv);
    scrollToBottom();

    getElements('.quiz-option').forEach(option => {
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

const handleQuizOption = async (event) => {
    const option = event.currentTarget;
    const selectedOption = option.dataset.option;
    const quizContainer = option.closest('.bot');
    const quizData = {
        pregunta: quizContainer.querySelector('p').textContent,
        respuesta: selectedOption,
        respuesta_correcta: quizContainer.dataset.respuestaCorrecta || '',
        tema: quizContainer.dataset.tema || 'General'
    };
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
            body: JSON.stringify(quizData)
        });
        if (!res.ok) throw new Error(`Error al responder quiz: ${res.status} - ${await res.text()}`);
        const data = await res.json();
        config.currentConvId = data.conv_id;
        localStorage.setItem('lastConvId', config.currentConvId);
        const isCorrect = data.es_correcta;
        option.classList.add(isCorrect ? 'correct' : 'incorrect');
        if (!isCorrect) {
            const correctOption = quizContainer.querySelector(`.quiz-option[data-option="${quizData.respuesta_correcta}"]`);
            if (correctOption) correctOption.classList.add('correct');
        }
        hideLoading(loadingDiv);
        const container = getElement('#chatbox')?.querySelector('.message-container');
        if (!container) return;

        let feedbackMessage = isCorrect
            ? `¡Correcto! ${data.explicacion}`
            : `Incorrecto. La opción correcta es: "${quizData.respuesta_correcta}". ${data.explicacion}`;
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

        config.historial.push({
            pregunta: quizData.pregunta,
            respuesta: feedbackMessage,
            tema: quizData.tema,
            es_correcta: isCorrect,
            opcion_seleccionada: selectedOption
        });
        if (config.historial.length > 10) config.historial.shift();
        localStorage.setItem('historial', JSON.stringify(config.historial));

        if (config.currentConvId) {
            await fetch(`${config.MESSAGES_URL}/${config.currentConvId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'bot', content: feedbackMessage, tema: quizData.tema })
            });
        }
    } catch (error) {
        handleFetchError(error, 'Respuesta de quiz');
        hideLoading(loadingDiv);
    }
};

const obtenerRecomendacion = async () => {
    const loadingDiv = showLoading();
    try {
        const res = await fetch(config.RECOMMEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: getHistorial() })
        });
        if (!res.ok) throw new Error(`Error al obtener recomendación: ${res.status} - ${await res.text()}`);
        const data = await res.json();
        config.currentConvId = data.conv_id;
        localStorage.setItem('lastConvId', config.currentConvId);
        hideLoading(loadingDiv);
        return data;
    } catch (error) {
        handleFetchError(error, 'Obtención de recomendación');
        hideLoading(loadingDiv);
        return { recommendation: 'No se pudo generar recomendación' };
    }
};

// --- Eventos y Inicialización ---
const toggleDropdown = (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (!dropdownMenu) return;
    dropdownMenu.classList.toggle('active');
    if (event) event.stopPropagation();
};

const setNivelExplicacion = (nivel) => {
    if (!['basica', 'ejemplos', 'avanzada'].includes(nivel)) {
        mostrarNotificacion('Error: Nivel inválido', 'error');
        return;
    }
    config.nivelExplicacion = nivel;
    localStorage.setItem('nivelExplicacion', nivel);
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        const nivelText = nivel === 'basica' ? 'Explicación Básica' :
                          nivel === 'ejemplos' ? 'Con Ejemplos de Código' :
                          'Avanzada/Teórica';
        nivelBtn.innerHTML = `${nivelText} <i class="fas fa-caret-down"></i>`;
        const dropdownMenu = getElement('.dropdown-menu');
        if (dropdownMenu && dropdownMenu.classList.contains('active')) {
            dropdownMenu.classList.remove('active');
        }
        mostrarNotificacion(`Nivel cambiado a: ${nivelText}`, 'success');
    }
};

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

const handleQuizClick = async () => {
    const quiz = await obtenerQuiz();
    if (quiz) mostrarQuizEnChat(quiz);
};

const handleRecommendClick = async () => {
    const data = await obtenerRecomendacion();
    const mensaje = data.recommendation;
    if (!mensaje) {
        mostrarNotificacion('No se pudo obtener recomendación', 'error');
        return;
    }
    const tema = mensaje.match(/Te recomiendo estudiar: (.*)/)?.[1] || 'General';
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

    config.historial.push({ pregunta: 'Recomendar tema', respuesta: mensaje, tema });
    if (config.historial.length > 10) config.historial.shift();
    localStorage.setItem('historial', JSON.stringify(config.historial));

    if (config.currentConvId) {
        await fetch(`${config.MESSAGES_URL}/${config.currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'bot', content: mensaje, tema })
        });
    }
};

const handleInputKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
};

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

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', handleCopy);
        btn.addEventListener('click', handleCopy);
    });
};

const handleCopy = (event) => {
    const btn = event.currentTarget;
    const text = btn.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
        mostrarNotificacion('Texto copiado al portapapeles', 'success');
        btn.innerHTML = `<i class="fas fa-check"></i>`;
        setTimeout(() => btn.innerHTML = `<i class="fas fa-copy"></i>`, 2000);
    }).catch(err => {
        mostrarNotificacion('Error al copiar texto', 'error');
    });
};

const init = () => {
    const modoOscuro = localStorage.getItem('modoOscuro') === 'true';
    if (modoOscuro) document.body.classList.add('modo-oscuro');

    setNivelExplicacion(config.nivelExplicacion);

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

    const logoutBtn = getElement('#logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', cerrarSesion);
        logoutBtn.setAttribute('data-tooltip', 'Cerrar Sesión');
        logoutBtn.setAttribute('aria-label', 'Cerrar sesión');
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
        if (config.currentConvId) {
            cargarMensajes(config.currentConvId);
        } else {
            mostrarMensajeBienvenida();
        }
        if (config.vozActiva && !config.userHasInteracted) toggleVoiceHint(true);
    }, 100);

    if ('speechSynthesis' in window) {
        speechSynthesis.onvoiceschanged = () => {
            speechSynthesis.getVoices();
        };
        speechSynthesis.getVoices();
    }
};

document.addEventListener('click', (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn && nivelBtn.contains(event.target)) return;
    if (dropdownMenu && dropdownMenu.contains(event.target)) return;
    if (dropdownMenu && dropdownMenu.classList.contains('active')) {
        dropdownMenu.classList.remove('active');
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

document.addEventListener('DOMContentLoaded', init);