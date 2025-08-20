let vozActiva = localStorage.getItem('vozActiva') === 'true' || false;
let isListening = false;
let recognition = null;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
let userHasInteracted = false;
let pendingWelcomeMessage = null;
let lastVoiceHintTime = 0;

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
    if (!voiceHint) return;
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
        console.warn('Audio desactivado o texto vacío, no se reproduce audio', { vozActiva, text });
        mostrarNotificacion('Audio desactivado o texto vacío', 'error');
        return;
    }

    if (!userHasInteracted) {
        console.warn('No se puede reproducir audio: el usuario no ha interactuado con la página');
        toggleVoiceHint(true);
        pendingWelcomeMessage = text;
        return;
    }

    let textoParaVoz = text;
    // Limpiar emojis, markdown y caracteres especiales
    textoParaVoz = textoParaVoz.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '');
    textoParaVoz = textoParaVoz.replace(/```[\s\S]*?```/g, '');
    textoParaVoz = textoParaVoz.replace(/`[^`]+`/g, '');
    textoParaVoz = textoParaVoz.replace(/\*\*([^*]+)\*\*/g, '$1');
    textoParaVoz = textoParaVoz.replace(/\*([^*]+)\*/g, '$1');
    textoParaVoz = textoParaVoz.replace(/#+\s*/g, '');
    textoParaVoz = textoParaVoz.replace(/-\s*/g, '');
    textoParaVoz = textoParaVoz.replace(/\n+/g, ' ');
    textoParaVoz = textoParaVoz.replace(/\bYELIA\b/g, 'Yelia');
    textoParaVoz = textoParaVoz.trim();

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
        console.log('Blob recibido del endpoint /tts:', blob);
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play().then(() => {
            console.log('Reproduciendo audio desde /tts');
        }).catch(error => {
            console.error('Error al reproducir audio desde /tts:', error);
            mostrarNotificacion('Error al reproducir audio: ' + error.message, 'error');
            if (error.message.includes("user didn't interact")) {
                toggleVoiceHint(true);
            }
            if (botMessage) botMessage.classList.remove('speaking');
        });
        currentAudio.onended = () => {
            console.log('Audio de /tts finalizado');
            if (botMessage) botMessage.classList.remove('speaking');
            currentAudio = null;
        };
    } catch (error) {
        console.error('Fallo en /tts, intentando speechSynthesis:', error);
        mostrarNotificacion(`Error en TTS: ${error.message}. Intentando audio local.`, 'error');

        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            console.log('Voces disponibles en speechSynthesis:', voices);
            const esVoice = voices.find(v => v.lang.includes('es'));
            if (!esVoice) {
                console.warn('No se encontró voz en español');
                mostrarNotificacion('No se encontró voz en español', 'error');
                if (botMessage) botMessage.classList.remove('speaking');
                return;
            }
            const utterance = new SpeechSynthesisUtterance(textoParaVoz);
            utterance.voice = esVoice;
            utterance.lang = 'es-MX';
            utterance.rate = 1;
            utterance.onend = () => {
                console.log('Audio local finalizado');
                if (botMessage) botMessage.classList.remove('speaking');
                currentAudio = null;
            };
            currentAudio = utterance;
            speechSynthesis.speak(utterance);
        } else {
            console.warn('SpeechSynthesis no soportado');
            mostrarNotificacion('El navegador no soporta síntesis de voz', 'error');
            if (botMessage) botMessage.classList.remove('speaking');
        }
    }
};

const stopSpeech = () => {
    console.log('Deteniendo cualquier audio en curso');
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
        try {
            recognition.stop();
            isListening = false;
            if (voiceToggleBtn) {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
            mostrarNotificacion('Reconocimiento de voz detenido', 'info');
        } catch (error) {
            mostrarNotificacion(`Error al detener voz: ${error.message}`, 'error');
            console.error('Error al detener reconocimiento de voz:', error);
        }
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if (!voiceToggleBtn) {
        console.error('Botón #voice-toggle-btn no encontrado');
        mostrarNotificacion('Error: No se encontró el botón de reconocimiento de voz', 'error');
        return;
    }
    if (!isListening) {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            mostrarNotificacion('Reconocimiento de voz no soportado en este navegador', 'error');
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
            mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
            console.error('Error en reconocimiento de voz:', event.error);
            recognition.stop();
            isListening = false;
            voiceToggleBtn.classList.remove('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar Voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
            } else {
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
    if (!avatarContainer) {
        console.error('Elemento .avatar-options no encontrado');
        return;
    }
    try {
        const response = await fetch('/avatars', { cache: 'no-store' });
        let avatares = [];
        if (response.ok) {
            avatares = await response.json();
        } else {
            avatares = [
                { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }
            ];
            console.warn('Usando avatares estáticos por fallo en /avatars');
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
        mostrarNotificacion(`Error al cargar avatares: ${error.message}`, 'error');
        console.error('Error al cargar avatares:', error);
        const fallbackAvatares = [
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png', animation_url: '' }
        ];
        localStorage.setItem('avatars', JSON.stringify(fallbackAvatares));
        avatarContainer.innerHTML = '';
        fallbackAvatares.forEach(avatar => {
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
    }
};

const guardarMensaje = (pregunta, respuesta, video_url = null, tema = null) => {
    const regex = /(\?Deseas saber más\?)(?:\s*\1)+/g;
    const respuestaLimpia = respuesta.replace(regex, '$1').trim();
    console.log('Guardando mensaje con respuesta limpia:', respuestaLimpia);

    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
        const newId = historial.length;
        currentConversation = {
            id: newId,
            nombre: `Chat ${new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`,
            timestamp: Date.now(),
            mensajes: []
        };
        historial.push({
            id: newId,
            nombre: currentConversation.nombre,
            timestamp: currentConversation.timestamp,
            mensajes: []
        });
        localStorage.setItem('chatHistory', JSON.stringify(historial));
    }
    currentConversation.mensajes.push({ pregunta, respuesta: respuestaLimpia, video_url, tema });
    if (currentConversation.mensajes.length > 5) {
        currentConversation.mensajes = currentConversation.mensajes.slice(-5);
    }
    localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    historial[currentConversation.id] = {
        id: currentConversation.id,
        nombre: currentConversation.nombre,
        timestamp: currentConversation.timestamp,
        mensajes: currentConversation.mensajes
    };
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
    scrollToBottom();
};

const actualizarListaChats = () => {
    const chatList = getElement('#chat-list');
    if (!chatList) {
        console.error('Elemento #chat-list no encontrado');
        return;
    }
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        if (!chat.id && chat.id !== 0) {
            console.warn(`Chat en índice ${index} no tiene id válido`, chat);
            return;
        }
        const li = document.createElement('li');
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp || Date.now()).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`}</span>
                        <div class="chat-actions">
                            <button class="rename-btn" data-tooltip="Renombrar" aria-label="Renombrar chat"><i class="fas fa-edit"></i></button>
                            <button class="delete-btn" data-tooltip="Eliminar" aria-label="Eliminar chat"><i class="fas fa-trash"></i></button>
                        </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp || Date.now()).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`);
        li.tabIndex = 0;
        chatList.appendChild(li);
        li.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON' && !e.target.closest('.chat-actions')) {
                cargarChat(index);
            }
        });
        li.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                cargarChat(index);
            }
        });
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => eliminarChat(index));
    });
    requestAnimationFrame(() => {
        chatList.scrollTop = chatList.scrollHeight;
    });
};

const cargarChat = index => {
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    const chat = historial[index];
    if (!chat) {
        console.error(`Chat con índice ${index} no encontrado`);
        mostrarNotificacion(`Error: Chat con índice ${index} no encontrado`, 'error');
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = chat.mensajes.map(msg => `
        <div class="user">${msg.pregunta}</div>
        <div class="bot">${typeof marked !== 'undefined' ? marked.parse(msg.respuesta) : msg.respuesta}
            <button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>
        </div>
    `).join('');
    scrollToBottom();
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, nombre: chat.nombre, timestamp: chat.timestamp, mensajes: chat.mensajes }));
    getElements('#chat-list li').forEach(li => li.classList.remove('selected'));
    getElement(`#chat-list li[data-index="${index}"]`)?.classList.add('selected');
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const renombrarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado para renombrar`);
        mostrarNotificacion(`Error: Chat con índice ${index} no encontrado`, 'error');
        return;
    }
    const nuevoNombre = prompt('Nuevo nombre para el chat:', historial[index].nombre);
    if (nuevoNombre) {
        historial[index].nombre = nuevoNombre;
        localStorage.setItem('chatHistory', JSON.stringify(historial));
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        if (currentConversation.id === index) {
            currentConversation.nombre = nuevoNombre;
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
        }
        actualizarListaChats();
        mostrarNotificacion('Chat renombrado con éxito', 'success');
    }
};

const eliminarChat = index => {
    if (!confirm('¿Eliminar este chat?')) return;
    let historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado en chatHistory`, historial);
        mostrarNotificacion(`Error: Chat con índice ${index} no encontrado`, 'error');
        return;
    }
    historial.splice(index, 1);
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id === index) {
        localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (container) container.innerHTML = '';
        mostrarNotificacion('Chat eliminado, conversación limpiada', 'info');
    }
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
};

const obtenerRecomendacion = async () => {
    try {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const contexto = currentConversation.mensajes || [];
        const response = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', historial: contexto }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /recommend: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.warn('Error en fetch /recommend, generando recomendación simulada:', error);
        return { recommendation: 'Patrones de diseño' };
    }
};

const obtenerQuiz = async (tipo) => {
    try {
        const usuario = localStorage.getItem('usuario') || 'anonimo';
        const nivel = localStorage.getItem('nivelExplicacion') || 'basica';
        const res = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, tipo, nivel })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Error en /quiz: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        console.log('Respuesta del endpoint /quiz:', data); // Para depuración
        return data;
    } catch (error) {
        console.error('Error al obtener quiz:', error);
        mostrarNotificacion(`Error al generar el quiz: ${error.message}`, 'error');
        return { error: error.message };
    }
};

const mostrarQuizEnChat = (quizData) => {
    if (quizData.error) {
        mostrarNotificacion(quizData.error, 'error');
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('No se encontró #chatbox o .message-container');
        mostrarNotificacion('Error: No se encontró el contenedor del chat', 'error');
        return;
    }

    const botDiv = document.createElement('div');
    botDiv.classList.add('bot');
    const opcionesHtml = quizData.opciones.map((opcion, i) => `
        <button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${quizData.respuesta_correcta}" data-tema="${quizData.tema}">
            ${quizData.tipo_quiz === 'verdadero_falso' ? opcion : `${i + 1}. ${opcion}`}
        </button>
    `).join('');
    const mensaje = `**Quiz sobre ${quizData.tema}:** ${quizData.pregunta}<div class="quiz-options">${opcionesHtml}</div>`;
    botDiv.innerHTML = `
        ${typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje}
        <button class="copy-btn" data-text="${quizData.pregunta}" aria-label="Copiar pregunta"><i class="fas fa-copy"></i></button>
    `;
    container.appendChild(botDiv);
    scrollToBottom();
    if (window.Prism) Prism.highlightAllUnder(botDiv);
    guardarMensaje('Quiz', `${quizData.pregunta}\nOpciones: ${quizData.opciones.join(', ')}`, null, quizData.tema);
    speakText(`Quiz sobre ${quizData.tema}: ${quizData.pregunta}`);

    getElements('.quiz-option').forEach(btn => {
        btn.addEventListener('click', async () => {
            getElements('.quiz-option').forEach(opt => opt.classList.remove('selected'));
            btn.classList.add('selected');
            const opcion = btn.dataset.opcion;
            const respuestaCorrecta = btn.dataset.respuesta_correcta;
            const tema = btn.dataset.tema;
            getElements('.quiz-option').forEach(opt => opt.disabled = true);

            try {
                const res = await fetch('/responder_quiz', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        usuario: localStorage.getItem('usuario') || 'anonimo',
                        respuesta: opcion,
                        respuesta_correcta: respuestaCorrecta,
                        tema: tema
                    })
                });
                const data = await res.json();
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                    return;
                }
                const responseDiv = document.createElement('div');
                responseDiv.classList.add('bot');
                responseDiv.innerHTML = `
                    ${typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta}
                    <button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>
                `;
                container.appendChild(responseDiv);
                scrollToBottom();
                const textoParaVoz = data.respuesta.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, '');
                speakText(textoParaVoz);
            } catch (error) {
                console.error('Error al responder quiz:', error);
                mostrarNotificacion('Error al responder el quiz', 'error');
            }
        });
    });
};

const sendMessage = () => {
    const input = getElement('#input');
    const nivelExplicacion = getElement('#nivel-explicacion').value || localStorage.getItem('nivelExplicacion') || 'basica';
    if (!input) {
        console.error('Elemento #input no encontrado');
        mostrarNotificacion('Error: Campo de entrada no encontrado', 'error');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) {
        return;
    }
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    input.value = '';
    scrollToBottom();

    guardarMensaje(pregunta, 'Esperando respuesta...');

    const loadingDiv = document.createElement('div');
    loadingDiv.classList.add('bot', 'loading');
    loadingDiv.textContent = '⌛ Generando respuesta...';
    container.appendChild(loadingDiv);
    scrollToBottom();

    const historial = JSON.parse(localStorage.getItem('currentConversation') || '{}').mensajes || [];
    fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pregunta,
            usuario: 'anonimo',
            avatar_id: selectedAvatar,
            nivel_explicacion: nivelExplicacion,
            historial
        })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /ask: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        container.removeChild(loadingDiv);
        const respuestaLimpia = data.respuesta;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(respuestaLimpia) : respuestaLimpia) +
            `<button class="copy-btn" data-text="${respuestaLimpia}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(respuestaLimpia);
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const mensajeIndex = currentConversation.mensajes.findIndex(m => m.pregunta === pregunta && m.respuesta === 'Esperando respuesta...');
        if (mensajeIndex !== -1) {
            currentConversation.mensajes[mensajeIndex].respuesta = respuestaLimpia;
            currentConversation.mensajes[mensajeIndex].video_url = data.video_url;
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
            const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
            historial[currentConversation.id] = currentConversation;
            localStorage.setItem('chatHistory', JSON.stringify(historial));
        }
        addCopyButtonListeners();
    }).catch(error => {
        if (loadingDiv && container.contains(loadingDiv)) {
            container.removeChild(loadingDiv);
        }
        mostrarNotificacion(`Error al obtener respuesta: ${error.message}`, 'error');
        console.error('Error en fetch /ask:', error);
        const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
        const mensajeIndex = currentConversation.mensajes.findIndex(m => m.pregunta === pregunta && m.respuesta === 'Esperando respuesta...');
        if (mensajeIndex !== -1) {
            currentConversation.mensajes[mensajeIndex].respuesta = 'Error al obtener respuesta';
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
            const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
            historial[currentConversation.id] = currentConversation;
            localStorage.setItem('chatHistory', JSON.stringify(historial));
        }
        actualizarListaChats();
    });
};

const limpiarChat = () => {
    stopSpeech();
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = '';
    localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
    mostrarNotificacion('Chat limpiado', 'success');
};

const nuevaConversacion = () => {
    stopSpeech();
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]').filter(chat => chat && typeof chat === 'object');
    const newId = historial.length;
    const newConversation = {
        id: newId,
        nombre: `Chat ${new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`,
        timestamp: Date.now(),
        mensajes: []
    };
    historial.push(newConversation);
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    localStorage.setItem('currentConversation', JSON.stringify(newConversation));
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container) container.innerHTML = '';
    actualizarListaChats();
    mostrarNotificacion('Nueva conversación iniciada', 'success');
};

const responderQuiz = (opcion, respuestaCorrecta, tema) => {
    fetch('/responder_quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario: 'anonimo', respuesta: opcion, respuesta_correcta: respuestaCorrecta, tema })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /responder_quiz: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        const chatbox = getElement('#chatbox');
        const container = chatbox?.querySelector('.message-container');
        if (!container || !chatbox) return;
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        const icono = data.es_correcta ? '<span class="quiz-feedback correct">✅</span>' : '<span class="quiz-feedback incorrect">❌</span>';
        botDiv.innerHTML = icono + (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + 
            `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(data.respuesta);
        guardarMensaje(`Respuesta al quiz sobre ${tema}`, data.respuesta);
        addCopyButtonListeners();
    }).catch(error => {
        mostrarNotificacion(`Error al responder quiz: ${error.message}`, 'error');
        console.error('Error en fetch /responder_quiz:', error);
    });
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.removeEventListener('click', btn._copyHandler);
        btn._copyHandler = () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado al portapapeles', 'success');
            }).catch(error => {
                mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
                console.error('Error al copiar texto:', error);
            });
        };
        btn.addEventListener('click', btn._copyHandler);
    });
};

const toggleDropdown = () => {
    const dropdownMenu = getElement('.dropdown-menu');
    if (dropdownMenu) {
        dropdownMenu.classList.toggle('active');
    }
};

const selectNivel = (nivel) => {
    const nivelBtn = getElement('#nivel-btn');
    const nivelSelect = getElement('#nivel-explicacion');
    if (nivelBtn && nivelSelect) {
        nivelBtn.textContent = nivel === 'basica' ? 'Básica' : nivel === 'ejemplos' ? 'Ejemplos' : 'Avanzada';
        nivelSelect.value = nivel;
        localStorage.setItem('nivelExplicacion', nivel);
        toggleDropdown();
        mostrarNotificacion(`Nivel de explicación: ${nivelBtn.textContent}`, 'success');
    }
};

const sincronizarNivelSelect = () => {
    const nivelSelect = getElement('#nivel-explicacion');
    const nivelBtn = getElement('#nivel-btn');
    if (nivelSelect && nivelBtn) {
        const nivelGuardado = localStorage.getItem('nivelExplicacion') || 'basica';
        nivelSelect.value = nivelGuardado;
        nivelBtn.textContent = nivelGuardado === 'basica' ? 'Básica' : nivelGuardado === 'ejemplos' ? 'Ejemplos' : 'Avanzada';
    }
};

const mostrarMensajeBienvenida = () => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    const mensaje = '¡Hola! Soy YELIA, tu asistente para Programación Avanzada en Ingeniería en Telemática. Estoy aquí para ayudarte. ¿Qué quieres aprender hoy?';
    const botDiv = document.createElement('div');
    botDiv.classList.add('bot');
    botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(mensaje) : mensaje) + 
        `<button class="copy-btn" data-text="${mensaje}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
    container.appendChild(botDiv);
    scrollToBottom();
    if (window.Prism) Prism.highlightAllUnder(botDiv);
    addCopyButtonListeners();
    speakText(mensaje);
    guardarMensaje('Bienvenida', mensaje);
};

const toggleMenu = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    if (!leftSection) {
        console.error('Elemento .left-section no encontrado');
        return;
    }
    leftSection.classList.toggle('active');
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
    if (!rightSection) {
        console.error('Elemento .right-section no encontrado');
        return;
    }
    rightSection.classList.toggle('active');
    if (leftSection && leftSection.classList.contains('active')) {
        leftSection.classList.remove('active');
    }
    const voiceHint = getElement('#voice-hint');
    if (voiceHint && rightSection.classList.contains('active')) {
        voiceHint.classList.add('hidden');
    }
};

const handleVoiceHint = () => {
    const voiceHint = getElement('#voice-hint');
    if (!voiceHint) {
        console.error('Elemento #voice-hint no encontrado');
        return;
    }
    document.addEventListener('click', () => {
        const voiceBtn = getElement('#voice-btn');
        const leftSection = getElement('.left-section');
        const rightSection = getElement('.right-section');
        if (voiceBtn && voiceBtn.textContent.includes('Activar Voz') && 
            (!leftSection || !leftSection.classList.contains('active')) && 
            (!rightSection || !rightSection.classList.contains('active'))) {
            voiceHint.classList.remove('hidden');
            setTimeout(() => {
                voiceHint.classList.add('hidden');
            }, 3000);
        }
    });
};

const closeMenusOnClickOutside = () => {
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');
    const menuToggle = getElement('.menu-toggle');
    const menuToggleRight = getElement('.menu-toggle-right');

    document.addEventListener('click', (event) => {
        if (!leftSection || !rightSection || !menuToggle || !menuToggleRight) return;
        const isClickInsideLeft = leftSection.contains(event.target) || menuToggle.contains(event.target);
        const isClickInsideRight = rightSection.contains(event.target) || menuToggleRight.contains(event.target);

        if (!isClickInsideLeft && leftSection.classList.contains('active')) {
            leftSection.classList.remove('active');
        }
        if (!isClickInsideRight && rightSection.classList.contains('active')) {
            rightSection.classList.remove('active');
        }
    });
};

const init = () => {
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
    const nivelSelect = getElement('#nivel-explicacion');
    const leftSection = getElement('.left-section');
    const rightSection = getElement('.right-section');

    if (menuToggle && leftSection) {
        menuToggle.addEventListener('click', () => {
            leftSection.classList.toggle('active');
            rightSection.classList.remove('active'); // Cerrar el otro menú
        });
        menuToggle.setAttribute('data-tooltip', 'Menú Izquierdo');
        menuToggle.setAttribute('aria-label', 'Abrir menú izquierdo');
    }
    if (menuToggleRight && rightSection) {
        menuToggleRight.addEventListener('click', () => {
            rightSection.classList.toggle('active');
            leftSection.classList.remove('active'); // Cerrar el otro menú
        });
        menuToggleRight.setAttribute('data-tooltip', 'Menú Derecho');
        menuToggleRight.setAttribute('aria-label', 'Abrir menú derecho');
    }
    if (leftSection) {
        const closeBtnLeft = document.createElement('button');
        closeBtnLeft.classList.add('close-menu-btn');
        closeBtnLeft.innerHTML = '<i class="fas fa-times"></i>';
        closeBtnLeft.setAttribute('aria-label', 'Cerrar menú izquierdo');
        leftSection.insertBefore(closeBtnLeft, leftSection.firstChild);
        closeBtnLeft.addEventListener('click', () => leftSection.classList.remove('active'));
    }
    if (rightSection) {
        const closeBtnRight = document.createElement('button');
        closeBtnRight.classList.add('close-menu-btn');
        closeBtnRight.innerHTML = '<i class="fas fa-times"></i>';
        closeBtnRight.setAttribute('aria-label', 'Cerrar menú derecho');
        rightSection.insertBefore(closeBtnRight, rightSection.firstChild);
        closeBtnRight.addEventListener('click', () => rightSection.classList.remove('active'));
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
        });
    }
    if (quizBtn) {
    quizBtn.setAttribute('data-tooltip', 'Obtener Quiz');
    quizBtn.setAttribute('aria-label', 'Generar un quiz');
    quizBtn.addEventListener('click', () => {
        console.log('Botón de quiz clickeado');
        obtenerQuiz('opciones').then(mostrarQuizEnChat).catch(error => {
            console.error('Error al procesar quiz:', error);
            mostrarNotificacion('Error al generar el quiz', 'error');
        });
    });
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
        clearBtn.addEventListener('click', limpiarChat);
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
    if (nivelSelect) {
        nivelSelect.addEventListener('change', () => {
            const nivel = nivelSelect.value;
            selectNivel(nivel);
        });
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
    closeMenusOnClickOutside();
    handleVoiceHint();
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
    sincronizarNivelSelect();
    mostrarMensajeBienvenida();
};

document.addEventListener('DOMContentLoaded', init);