let vozActiva = localStorage.getItem('vozActiva') === 'true';
let isListening = false;
let recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;
let lastVoiceHintTime = 0;
let currentConvId = null;
let TEMAS_DISPONIBLES = [
    'Introducción a la POO', 'Clases y Objetos', 'Encapsulamiento', 'Herencia',
    'Polimorfismo', 'Clases Abstractas e Interfaces', 'UML', 'Diagramas UML',
    'Patrones de Diseño en POO', 'Patrón MVC', 'Acceso a Archivos',
    'Bases de Datos y ORM', 'Integración POO + MVC + BD', 'Pruebas y Buenas Prácticas'
];

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

const mostrarNotificacion = (mensaje, tipo = 'info') => {
    const card = getElement('#notification-card');
    if (!card) {
        console.error('Elemento #notification-card no encontrado');
        return;
    }
    card.innerHTML = `
        <p>${mensaje}</p>
        <button onclick="this.parentElement.classList.remove('active')" aria-label="Cerrar notificación">Cerrar</button>
    `;
    card.classList.add('active', tipo);
    card.style.animation = 'fadeIn 0.5s ease-out';
    setTimeout(() => {
        card.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => card.classList.remove('active', tipo), 500);
    }, 5000);
};

const toggleVoiceHint = (show) => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) {
        console.error('Elemento #voice-hint no encontrado');
        return;
    }
    const now = Date.now();
    if (show && now - lastVoiceHintTime < 5000) return;
    voiceHint.style.display = show ? 'block' : 'none';
    voiceHint.classList.toggle('hidden', !show);
    if (show) lastVoiceHintTime = now;
};

const scrollToBottom = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!chatbox || !container) return;
    requestAnimationFrame(() => {
        chatbox.scrollTop = chatbox.scrollHeight;
        const lastMessage = container.lastElementChild;
        if (lastMessage) {
            lastMessage.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    });
};

const updateAvatarDisplay = () => {
    const avatarImg = getElement('#avatar-img');
    if (!avatarImg) return;
    const avatars = JSON.parse(localStorage.getItem('avatars') || '[]');
    const selected = avatars.find(a => a.avatar_id === selectedAvatar) || { url: '/static/img/default-avatar.png' };
    avatarImg.src = selected.url;
    avatarImg.classList.add('animate-avatar');
    setTimeout(() => avatarImg.classList.remove('animate-avatar'), 300);
};

const speakText = async (text) => {
    console.log('Intentando reproducir audio:', { vozActiva, text, userHasInteracted });
    if (!vozActiva || !text) {
        console.warn('Audio desactivado o texto vacío', { vozActiva, text });
        mostrarNotificacion('Audio desactivado o texto vacío', 'error');
        return;
    }
    if (!userHasInteracted) {
        console.warn('No se puede reproducir audio: el usuario no ha interactuado');
        toggleVoiceHint(true);
        pendingWelcomeMessage = text;
        return;
    }
    let textoParaVoz = text
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/#+\s*/g, '')
        .replace(/-\s*/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\bYELIA\b/g, 'Yelia')
        .trim();
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    if (currentAudio) {
        if (currentAudio instanceof Audio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        } else if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        currentAudio = null;
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
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play().catch(error => {
            console.error('Error al reproducir audio:', error);
            mostrarNotificacion('Error al reproducir audio: ' + error.message, 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        });
        currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
            currentAudio = null;
        };
    } catch (error) {
        console.error('Fallo en /tts, intentando speechSynthesis:', error);
        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            const esVoice = voices.find(v => v.lang.includes('es'));
            if (!esVoice) {
                console.warn('No se encontró voz en español');
                mostrarNotificacion('No se encontró voz en español', 'error');
                if (botMessage) botMessage.classList.remove('speaking');
                return;
            }
            const utterance = new SpeechSynthesisUtterance(textoParaVoz);
            utterance.lang = 'es-ES';
            utterance.voice = esVoice;
            utterance.pitch = 1;
            utterance.rate = 0.9;
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
            utterance.onerror = (event) => {
                console.error('Error en speechSynthesis:', event.error);
                mostrarNotificacion('Error en audio local: ' + event.error, 'error');
                if (botMessage) botMessage.classList.remove('speaking');
            };
            speechSynthesis.speak(utterance);
            currentAudio = utterance;
        } else {
            console.warn('speechSynthesis no soportado');
            mostrarNotificacion('Audio no soportado en este navegador', 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

const stopSpeech = () => {
    console.log('Deteniendo audio');
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    }
    currentAudio = null;
    if (isListening && recognition) {
        recognition.stop();
        isListening = false;
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
    if (!isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado', 'error');
            return;
        }
        recognition = ('webkitSpeechRecognition' in window) ? new webkitSpeechRecognition() : new SpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.continuous = true;
        recognition.start();
        isListening = true;
        voiceToggleBtn.classList.add('voice-active');
        voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
        voiceToggleBtn.setAttribute('data-tooltip', 'Detener Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Detener reconocimiento de voz');
        mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        recognition.onresult = event => {
            const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            const input = getElement('#input');
            if (input) input.value = transcript;
            if (event.results[event.results.length - 1].isFinal) {
                sendMessage();
                recognition.stop();
                isListening = false;
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        recognition.onerror = event => {
            mostrarNotificacion(`Error en voz: ${event.error}`, 'error');
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) recognition.start();
            else {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
    } else {
        stopSpeech();
    }
};

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
            if (avatar.avatar_id === selectedAvatar) img.classList.add('selected');
            avatarContainer.appendChild(img);
            img.addEventListener('click', () => {
                getElements('.avatar-option').forEach(opt => opt.classList.remove('selected'));
                img.classList.add('selected');
                selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                updateAvatarDisplay();
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
        updateAvatarDisplay();
    } catch (error) {
        console.error('Error al cargar avatares:', error);
        mostrarNotificacion('Error al cargar avatares', 'error');
    }
};

const cargarConversaciones = async () => {
    try {
        const res = await fetch('/conversations');
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();
        const chatList = getElement('#chat-list');
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
                currentConvId = conv.id;
                localStorage.setItem('lastConvId', currentConvId); // 🔹 Guarda último chat
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

        // Si hay chats y no hay conversación activa, cargar último usado
        if (data.conversations.length > 0 && !currentConvId) {
            const lastConvId = localStorage.getItem('lastConvId');
            if (lastConvId) {
                currentConvId = parseInt(lastConvId);
                if (!isNaN(currentConvId)) {
                    cargarMensajes(currentConvId);
                }
            } else {
                currentConvId = data.conversations[0].id;
                cargarMensajes(currentConvId);
                localStorage.setItem('lastConvId', currentConvId);
            }
        } else if (data.conversations.length === 0) {
            mostrarMensajeBienvenida();
        }
    } catch (error) {
        console.error('Error cargando conversaciones:', error);
        mostrarNotificacion(`Error al cargar historial: ${error.message}. Verifica la conexión a la base de datos.`, 'error');
    }
};

const cargarMensajes = async (convId) => {
    if (!convId) {
        console.warn("⚠️ No hay convId válido, no se pueden cargar mensajes.");
        return;
    }
    currentConvId = convId;

    try {
        const res = await fetch(`/messages/${convId}`);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Error HTTP ${res.status}: ${text}`);
        }
        const data = await res.json();

        const container = getElement('#chatbox').querySelector('.message-container');
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
        console.error('Error cargando mensajes:', error);
        mostrarNotificacion(`Error al cargar mensajes: ${error.message}`, 'error');
    }
};

const eliminarConversacion = async (convId) => {
    if (!confirm("¿Estás seguro de que quieres eliminar esta conversación?")) return;
    try {
        const res = await fetch(`/conversations/${convId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            if (currentConvId === convId) {
                currentConvId = null;
                getElement('#chatbox').querySelector('.message-container').innerHTML = '';
                mostrarMensajeBienvenida();
            }
            cargarConversaciones();
            mostrarNotificacion('Conversación eliminada', 'success');
        } else {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Error al eliminar conversación');
        }
    } catch (error) {
        console.error('Error eliminando conversación:', error);
        mostrarNotificacion(`Error al eliminar conversación: ${error.message}. Verifica la conexión a la base de datos.`, 'error');
    }
};


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
        console.error('Error renombrando conversación:', error);
        mostrarNotificacion(`Error al renombrar conversación: ${error.message}. Verifica la conexión a la base de datos.`, 'error');
    }
};

const sendMessage = async () => {
    const input = getElement('#input');
    const pregunta = input.value.trim();
    if (!pregunta) return;
    input.value = '';

    const container = getElement('#chatbox').querySelector('.message-container');

    // Mostrar mensaje del usuario en pantalla al instante
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.innerHTML = pregunta + 
        `<button class="copy-btn" data-text="${pregunta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(userDiv);
    scrollToBottom();

    // Crear conversación si aún no existe
    if (!currentConvId) {
        try {
            const res = await fetch('/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = await res.json();
            currentConvId = data.id;
            await cargarConversaciones();
        } catch (error) {
            console.error('Error creando conversación:', error);
            mostrarNotificacion('Error al crear nueva conversación', 'error');
            return;
        }
    }

    // 1. Guardar mensaje del usuario en la BD
    try {
        await fetch(`/messages/${currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: "user", content: pregunta })
        });
    } catch (error) {
        console.error('Error guardando mensaje usuario:', error);
    }

    // 2. Pedir respuesta a la IA
    try {
        const res = await fetch('/buscar_respuesta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pregunta,
                historial: [],
                nivel_explicacion: localStorage.getItem('nivelExplicacion') || 'basica',
                conv_id: currentConvId
            })
        });
        const data = await res.json();

        // 3. Mostrar respuesta del bot en pantalla
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
            `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();
        speakText(data.respuesta);

        // 4. Guardar mensaje del bot en la BD
        await fetch(`/messages/${currentConvId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: "bot", content: data.respuesta })
        });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        mostrarNotificacion('Error al enviar mensaje', 'error');
    }
};

const nuevaConversacion = async () => {
    try {
        const res = await fetch('/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await res.json();
        currentConvId = data.id;
        getElement('#chatbox').querySelector('.message-container').innerHTML = '';
        await cargarConversaciones();
        mostrarMensajeBienvenida();
    } catch (error) {
        console.error('Error creando nueva conversación:', error);
        mostrarNotificacion('Error al crear nueva conversación', 'error');
    }
};

const vaciarChat = async () => {
    if (!currentConvId) return;
    await nuevaConversacion();
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado al portapapeles', 'success');
                btn.innerHTML = `<i class="fas fa-check"></i>`;
                setTimeout(() => btn.innerHTML = `<i class="fas fa-copy"></i>`, 2000);
            }).catch(err => {
                console.error('Error al copiar texto:', err);
                mostrarNotificacion('Error al copiar texto', 'error');
            });
        });
    });
};
// Abrir / Cerrar menú de opciones
const toggleDropdown = () => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (!dropdownMenu) return;
    dropdownMenu.classList.toggle('active');
};

// Selección de nivel de explicación
const setNivelExplicacion = (nivel) => {
    localStorage.setItem('nivelExplicacion', nivel);
    const nivelBtn = getElement('#nivel-btn');
    if (nivelBtn) {
        nivelBtn.textContent = nivel === 'basica'
            ? 'Explicación Básica'
            : nivel === 'ejemplos'
            ? 'Con Ejemplos de Código'
            : 'Avanzada/Teórica';

        mostrarNotificacion(`Nivel cambiado a: ${nivelBtn.textContent}`, 'success');
    } else {
        console.error('Elemento #nivel-btn no encontrado');
        mostrarNotificacion('Error: Botón de nivel no encontrado', 'error');
    }

    // Cerrar menú después de elegir opción
    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) dropdownMenu.classList.remove('active');
};

// Detectar si es móvil
const isMobile = () => window.innerWidth < 768;

// Cerrar menú cuando hago clic afuera (funciona en PC y móvil)
document.addEventListener('click', (event) => {
    const dropdownMenu = getElement('.dropdown-menu');
    const nivelBtn = getElement('#nivel-btn');

    if (dropdownMenu && dropdownMenu.classList.contains('active')) {
        if (!dropdownMenu.contains(event.target) && !nivelBtn.contains(event.target)) {
            dropdownMenu.classList.remove('active');
        }
    }

    // Menús laterales (tu lógica original para móvil)
    if (isMobile()) {
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');

        if (leftSection && leftSection.classList.contains('active') &&
            !leftSection.contains(event.target) && !getElement('.menu-toggle').contains(event.target)) {
            toggleMenu();
        }
        if (rightSection && rightSection.classList.contains('active') &&
            !rightSection.contains(event.target) && !getElement('.menu-toggle-right').contains(event.target)) {
            toggleRightMenu();
        }
    }
});

const mostrarMensajeBienvenida = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        mostrarNotificacion('Error: Contenedor de chat no encontrado', 'error');
        return;
    }

    const mensaje = '👋 ¡Hola! Soy YELIA, tu asistente de Programación Avanzada en Ingeniería en Telemática. ¿Qué quieres aprender hoy?';
    
    // 🔹 Solo agregar el saludo si el chat está vacío
    if (container.children.length === 0) {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje, { breaks: true, gfm: true }) : mensaje) +
            `<button class="copy-btn" data-text="${mensaje.replace(/"/g, '&quot;')}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAll();

        // 🔊 Voz (solo si activada)
        if (vozActiva && userHasInteracted) {
            speakText(mensaje);
        } else if (vozActiva) {
            pendingWelcomeMessage = mensaje;
        }
    }
};

const obtenerQuiz = async (tipo) => {
    try {
        const res = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', nivel: localStorage.getItem('nivelExplicacion') || 'basico' })
        });
        if (!res.ok) throw new Error('Error al obtener quiz');
        return await res.json();
    } catch (error) {
        console.error('Error obteniendo quiz:', error);
        mostrarNotificacion('Error al obtener quiz', 'error');
        return null;
    }
};

const mostrarQuizEnChat = async (quizData) => {
    if (!quizData) return;
    const container = getElement('#chatbox').querySelector('.message-container');
    const quizDiv = document.createElement('div');
    quizDiv.classList.add('bot');
    let optionsHtml = quizData.opciones.map((opcion, index) => `
        <div class="quiz-option" data-option="${opcion}" data-index="${index}">${opcion}</div>
    `).join('');
    quizDiv.innerHTML = `
        <p>${quizData.pregunta}</p>
        <div class="quiz-options">${optionsHtml}</div>
        <button class="copy-btn" data-text="${quizData.pregunta}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>
    `;
    container.appendChild(quizDiv);
    scrollToBottom();

    getElements('.quiz-option').forEach(option => {
        option.addEventListener('click', async () => {
            const selectedOption = option.dataset.option;
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
                const data = await res.json();
                const feedbackDiv = document.createElement('div');
                feedbackDiv.classList.add('bot');
                feedbackDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) +
                    `<button class="copy-btn" data-text="${data.respuesta.replace(/"/g, '&quot;')}" aria-label="Copiar respuesta"><i class="fas fa-copy"></i></button>`;
                container.appendChild(feedbackDiv);
                scrollToBottom();
                if (window.Prism) Prism.highlightAll();
                speakText(data.respuesta);
                addCopyButtonListeners();
            } catch (error) {
                console.error('Error respondiendo quiz:', error);
                mostrarNotificacion('Error al responder quiz', 'error');
            }
        });
    });
    addCopyButtonListeners();
};

const obtenerRecomendacion = async () => {
    try {
        const res = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: [] })
        });
        if (!res.ok) throw new Error('Error al obtener recomendación');
        return await res.json();
    } catch (error) {
        console.error('Error obteniendo recomendación:', error);
        mostrarNotificacion('Error al obtener recomendación', 'error');
        return { recommendation: 'No se pudo generar recomendación' };
    }
};

const init = () => {
    // Inicializar quizHistory
    quizHistory = JSON.parse(localStorage.getItem('quizHistory') || '[]');

    // Obtener temas desde el backend
    fetch('/temas', { method: 'GET' })
        .then(res => res.json())
        .then(data => {
            if (data.temas && Array.isArray(data.temas)) {
                TEMAS_DISPONIBLES = data.temas;
                console.log('Temas cargados:', TEMAS_DISPONIBLES);
            } else {
                console.warn('No se pudieron cargar temas, usando lista por defecto');
                TEMAS_DISPONIBLES = [
                    'Introducción a la POO',
                    'Clases y Objetos',
                    'Encapsulamiento',
                    'Herencia',
                    'Polimorfismo',
                    'Clases Abstractas e Interfaces',
                    'UML',
                    'Diagramas UML',
                    'Patrones de Diseño en POO',
                    'Patrón MVC',
                    'Acceso a Archivos',
                    'Bases de Datos y ORM',
                    'Integración POO + MVC + BD',
                    'Pruebas y Buenas Prácticas',
                    'Concurrencia'
                ];
            }
        })
        .catch(error => {
            console.error('Error al cargar temas:', error);
            TEMAS_DISPONIBLES = [
                'Introducción a la POO',
                'Clases y Objetos',
                'Encapsulamiento',
                'Herencia',
                'Polimorfismo',
                'Clases Abstractas e Interfaces',
                'UML',
                'Diagramas UML',
                'Patrones de Diseño en POO',
                'Patrón MVC',
                'Acceso a Archivos',
                'Bases de Datos y ORM',
                'Integración POO + MVC + BD',
                'Pruebas y Buenas Prácticas',
                'Concurrencia'
            ];
        });

    // Resto de la función init (sin cambios)
    const menuToggle = getElement('.menu-toggle');
    const menuToggleRight = getElement('.menu-toggle-right');
    const modoBtn = getElement('#modo-btn');
    const voiceBtn = getElement('#voice-btn');
    const quizBtn = getElement('#quiz-btn');
    const recommendBtn = getElement('#recommend-btn');
    const sendBtn = getElement('#send-btn');
    const newChatBtn = getElement('#new-chat-btn');
    const clearBtn = getElement('#btn-clear');
    const nivelBtn = getElement('#nivel-btn');
    const voiceToggleBtn = getElement('#voice-toggle-btn');

    if (menuToggle) {
        menuToggle.addEventListener('click', toggleMenu);
        menuToggle.setAttribute('data-tooltip', 'Menú Izquierdo');
        menuToggle.setAttribute('aria-label', 'Abrir menú izquierdo');
    }
    if (menuToggleRight) {
        menuToggleRight.addEventListener('click', toggleRightMenu);
        menuToggleRight.setAttribute('data-tooltip', 'Menú Derecho');
        menuToggleRight.setAttribute('aria-label', 'Abrir menú derecho');
    }
    if (modoBtn) {
        const modoOscuro = localStorage.getItem('modoOscuro') === 'true';
        modoBtn.setAttribute('data-tooltip', modoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
        modoBtn.setAttribute('aria-label', modoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
        modoBtn.innerHTML = `
            <i class="fas ${modoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
            <span id="modo-text">${modoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
        `;
        modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-oscuro');
            const isModoOscuro = document.body.classList.contains('modo-oscuro');
            localStorage.setItem('modoOscuro', isModoOscuro);
            modoBtn.setAttribute('data-tooltip', isModoOscuro ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
            modoBtn.setAttribute('aria-label', isModoOscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
            modoBtn.innerHTML = `
                <i class="fas ${isModoOscuro ? 'fa-sun' : 'fa-moon'}"></i>
                <span id="modo-text">${isModoOscuro ? 'Modo Claro' : 'Modo Oscuro'}</span>
            `;
            mostrarNotificacion(`Modo ${isModoOscuro ? 'oscuro' : 'claro'} activado`, 'success');
        });
    }
    if (voiceBtn) {
        voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
        voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
        voiceBtn.innerHTML = `
            <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
            <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
        `;
        voiceBtn.addEventListener('click', () => {
            vozActiva = !vozActiva;
            localStorage.setItem('vozActiva', vozActiva);
            voiceBtn.innerHTML = `
                <i class="fas ${vozActiva ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
                <span id="voice-text">${vozActiva ? 'Desactivar Audio' : 'Activar Audio'}</span>
            `;
            voiceBtn.setAttribute('data-tooltip', vozActiva ? 'Desactivar Audio' : 'Activar Audio');
            voiceBtn.setAttribute('aria-label', vozActiva ? 'Desactivar audio' : 'Activar audio');
            mostrarNotificacion(`Audio ${vozActiva ? 'activado' : 'desactivado'}`, 'success');
            if (!vozActiva) stopSpeech();
            if (vozActiva && !userHasInteracted) toggleVoiceHint(true);
        });
    }
    if (quizBtn) {
        quizBtn.setAttribute('data-tooltip', 'Obtener Quiz');
        quizBtn.setAttribute('aria-label', 'Generar un quiz');
        quizBtn.addEventListener('click', () => obtenerQuiz('opciones').then(mostrarQuizEnChat));
    }
    if (recommendBtn) {
        recommendBtn.setAttribute('data-tooltip', 'Obtener Recomendación');
        recommendBtn.setAttribute('aria-label', 'Obtener recomendación de tema');
        recommendBtn.addEventListener('click', () => obtenerRecomendacion().then(data => {
            const mensaje = `Recomendación: ${data.recommendation}`;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) +
                `<button class="copy-btn" data-text="${mensaje}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            getElement('#chatbox').querySelector('.message-container').appendChild(botDiv);
            scrollToBottom();
            speakText(mensaje);
            guardarMensaje('Recomendación', mensaje);
            addCopyButtonListeners();
        }));
    }
    if (sendBtn) {
        sendBtn.setAttribute('data-tooltip', 'Enviar');
        sendBtn.setAttribute('aria-label', 'Enviar mensaje');
        sendBtn.addEventListener('click', sendMessage);
    }
    if (newChatBtn) {
        newChatBtn.setAttribute('data-tooltip', 'Nuevo Chat');
        newChatBtn.setAttribute('aria-label', 'Iniciar nueva conversación');
        newChatBtn.addEventListener('click', nuevaConversacion);
    }
    if (clearBtn) {
        clearBtn.setAttribute('data-tooltip', 'Limpiar Chat');
        clearBtn.setAttribute('aria-label', 'Limpiar chat actual');
        clearBtn.addEventListener('click', nuevaConversacion);
    }
    if (nivelBtn) {
        nivelBtn.setAttribute('data-tooltip', 'Cambiar Nivel');
        nivelBtn.setAttribute('aria-label', 'Cambiar nivel de explicación');
        nivelBtn.addEventListener('click', toggleDropdown);
    }
    if (voiceToggleBtn) {
        voiceToggleBtn.setAttribute('data-tooltip', 'Voz');
        voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }
    const inputElement = getElement('#input');
    if (inputElement) {
        inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }
    // Mostrar mensaje de bienvenida y mensaje de interacción para audio
    setTimeout(() => {
        mostrarMensajeBienvenida();
        if (vozActiva && !userHasInteracted) {
            toggleVoiceHint(true);
        }
    }, 100);
    document.addEventListener('click', () => {
        if (!userHasInteracted) {
            userHasInteracted = true;
            toggleVoiceHint(false);
            console.log('Interacción detectada, audio habilitado');
            if (pendingWelcomeMessage) {
                speakText(pendingWelcomeMessage);
                pendingWelcomeMessage = null;
            }
        }
    }, { once: true });
    cargarAvatares();
    actualizarListaChats();
};

document.addEventListener('DOMContentLoaded', init);