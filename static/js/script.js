let vozActiva = true, isListening = false, recognition = null, voicesLoaded = false;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;

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
        <button onclick="this.parentElement.classList.remove('active')">Cerrar</button>
    `;
    card.classList.add('active', tipo);
    card.style.animation = 'fadeIn 0.5s ease-out';
    setTimeout(() => {
        card.style.animation = 'fadeOut 0.5s ease-out';
        setTimeout(() => card.classList.remove('active', tipo), 500);
    }, 5000);
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

const speakText = text => {
    if (!vozActiva || !text) {
        console.warn('Voz desactivada o texto vacío, no se reproduce voz', { vozActiva, text });
        return;
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    console.log('speakText called with:', text);
    fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en TTS: ${res.status} ${res.statusText}`);
            });
        }
        return res.blob();
    }).then(blob => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play().catch(error => {
            console.error('Error al reproducir audio:', error);
            mostrarNotificacion('Error al reproducir voz de IA: ' + error.message, 'error');
        });
        currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
        };
    }).catch(error => {
        console.error('TTS /tts falló, intentando speechSynthesis', error.message);
        mostrarNotificacion(`Error en TTS: ${error.message}`, 'error');
        if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = 'es-ES';
            utterance.onend = () => {
                if (botMessage) botMessage.classList.remove('speaking');
            };
            utterance.onerror = (event) => {
                console.error('Error en speechSynthesis:', event.error);
                mostrarNotificacion('Error en voz de IA: ' + event.error, 'error');
            };
            speechSynthesis.speak(utterance);
            currentAudio = utterance;
        } else {
            console.error('speechSynthesis no soportado en este navegador');
            mostrarNotificacion('Reconocimiento de voz no soportado en este navegador', 'error');
        }
    });
};

const stopSpeech = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
    if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
    }
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
    }
    if (isListening && recognition) {
        try {
            recognition.stop();
            isListening = false;
            if (voiceToggleBtn) {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
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
        voiceToggleBtn.setAttribute('data-tooltip', 'Detener reconocimiento de voz');
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
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
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
            voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
            voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
            } else {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
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
                { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png' },
                { avatar_id: 'poo', nombre: 'POO', url: '/static/img/poo.png' }
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
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png' },
            { avatar_id: 'poo', nombre: 'POO', url: '/static/img/poo.png' }
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

const guardarMensaje = (pregunta, respuesta, video_url = null) => {
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
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
    currentConversation.mensajes.push({ pregunta, respuesta, video_url });
    localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
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
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`}</span>
                        <div class="chat-actions">
                            <button class="rename-btn" data-tooltip="Renombrar chat" aria-label="Renombrar chat"><i class="fas fa-edit"></i></button>
                            <button class="delete-btn" data-tooltip="Eliminar chat" aria-label="Eliminar chat"><i class="fas fa-trash"></i></button>
                        </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString('es-ES', { timeZone: 'America/Bogota' })}`);
        chatList.appendChild(li);
        li.addEventListener('click', e => {
            if (e.target.tagName !== 'BUTTON' && !e.target.closest('.chat-actions')) {
                cargarChat(index);
            }
        });
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => {
            console.log('Índice de chat a eliminar:', index);
            eliminarChat(index);
        });
    });
    requestAnimationFrame(() => {
        chatList.scrollTop = chatList.scrollHeight;
    });
};

const cargarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const chat = historial[index];
    if (!chat) {
        console.error(`Chat con índice ${index} no encontrado`);
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
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado para renombrar`);
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
    let historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (!historial[index]) {
        console.error(`Chat con índice ${index} no encontrado en chatHistory`, historial);
        mostrarNotificacion(`Error: Chat con índice ${index} no encontrado`, 'error');
        return;
    }
    console.log(`Eliminando chat con índice ${index}:`, historial[index]);
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

const cargarAnalytics = async () => {
    const analyticsContainer = getElement('#analytics');
    if (!analyticsContainer) {
        console.error('Elemento #analytics no encontrado');
        return;
    }
    try {
        const response = await fetch('/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo' }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /analytics: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        analyticsContainer.innerHTML = data.map(item => `<p>${item.tema}: Tasa de acierto ${item.tasa_acierto * 100}%</p>`).join('');
    } catch (error) {
        console.warn('Error en fetch /analytics, usando datos de prueba:', error);
        const datosPrueba = [
            { tema: 'POO', tasa_acierto: 0.85 },
            { tema: 'Estructuras de Datos', tasa_acierto: 0.70 }
        ];
        analyticsContainer.innerHTML = datosPrueba.map(item => `<p>${item.tema}: Tasa de acierto ${item.tasa_acierto * 100}%</p>`).join('');
        mostrarNotificacion('Analytics no disponible, mostrando datos de prueba', 'info');
    }
};

const obtenerRecomendacion = async () => {
    try {
        const response = await fetch('/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', contexto: '' }),
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

const obtenerQuiz = async () => {
    try {
        const response = await fetch('/quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario: 'anonimo', tema: 'POO' }),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new Error(`Error en /quiz: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.warn('Error en fetch /quiz, generando quiz simulado:', error);
        return {
            quiz: [{
                pregunta: '¿Qué es la encapsulación en POO?',
                opciones: ['Ocultar datos', 'Herencia', 'Polimorfismo', 'Abstracción'],
                respuesta_correcta: 'Ocultar datos',
                tema: 'POO'
            }]
        };
    }
};

const sendMessage = () => {
    const input = getElement('#input');
    if (!input) {
        console.error('Elemento #input no encontrado');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) {
        mostrarNotificacion('Por favor, escribe un mensaje.', 'error');
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
    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, avatar: selectedAvatar })
    }).then(res => {
        if (!res.ok) {
            return res.json().then(err => {
                throw new Error(err.error || `Error en /respuesta: ${res.status} ${res.statusText}`);
            });
        }
        return res.json();
    }).then(data => {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot');
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
        container.appendChild(botDiv);
        scrollToBottom();
        if (window.Prism) Prism.highlightAllUnder(botDiv);
        speakText(data.respuesta);
        guardarMensaje(pregunta, data.respuesta, data.video_url);
        addCopyButtonListeners();
    }).catch(error => {
        mostrarNotificacion(`Error al obtener respuesta: ${error.message}`, 'error');
        console.error('Error en fetch /respuesta:', error);
    });
};

const limpiarChat = () => {
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
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
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

const buscarTema = () => {
    const searchInput = getElement('#search-input');
    if (!searchInput) {
        console.error('Elemento #search-input no encontrado');
        return;
    }
    const tema = searchInput.value.trim();
    if (!tema) {
        mostrarNotificacion('Por favor, escribe un tema para buscar.', 'error');
        return;
    }
    const input = getElement('#input');
    if (input) {
        input.value = `Explica ${tema} en el contexto de programación avanzada`;
        sendMessage();
    }
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
        botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(data.respuesta) : data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
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
        btn.addEventListener('click', () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado al portapapeles', 'success');
            }).catch(error => {
                mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
                console.error('Error al copiar texto:', error);
            });
        });
    });
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        sendBtn: document.getElementById('send-btn'),
        recommendBtn: document.getElementById('recommend-btn'),
        quizBtn: document.getElementById('quiz-btn'),
        newChatBtn: document.getElementById('new-chat-btn'),
        clearBtn: document.getElementById('btn-clear'),
        voiceBtn: document.getElementById('voice-btn'),
        voiceToggleBtn: document.getElementById('voice-toggle-btn'),
        modoBtn: document.getElementById('modo-btn'),
        searchBtn: document.getElementById('search-btn'),
        searchInput: document.getElementById('search-input'),
        menuToggle: document.querySelector('.menu-toggle'),
        menuToggleRight: document.querySelector('.menu-toggle-right'),
        tabButtons: document.querySelectorAll('.tab-btn')
    };

    console.log('Elementos encontrados:', elements);

    cargarAvatares();
    actualizarListaChats();
    cargarAnalytics();

    if (elements.sendBtn) {
        elements.sendBtn.addEventListener('click', () => {
            console.log('Botón #send-btn clicado');
            sendMessage();
        });
    } else {
        console.error('Botón #send-btn no encontrado');
        mostrarNotificacion('Error: Botón de enviar mensaje no encontrado', 'error');
    }

    if (elements.recommendBtn) {
        elements.recommendBtn.addEventListener('click', async () => {
            console.log('Botón #recommend-btn clicado');
            const data = await obtenerRecomendacion();
            const chatbox = getElement('#chatbox');
            const container = chatbox?.querySelector('.message-container');
            if (!container || !chatbox) return;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            const recomendacion = `Te recomiendo estudiar: ${data.recommendation}`;
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(recomendacion) : recomendacion) + `<button class="copy-btn" data-text="${recomendacion}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(botDiv);
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(botDiv);
            speakText(recomendacion);
            guardarMensaje('Recomendación', recomendacion);
            addCopyButtonListeners();
        });
    } else {
        console.error('Botón #recommend-btn no encontrado');
        mostrarNotificacion('Error: Botón de recomendación no encontrado', 'error');
    }

    if (elements.quizBtn) {
        elements.quizBtn.addEventListener('click', async () => {
            console.log('Botón #quiz-btn clicado');
            const data = await obtenerQuiz();
            const chatbox = getElement('#chatbox');
            const container = chatbox?.querySelector('.message-container');
            if (!container || !chatbox) return;
            const quiz = data.quiz[0];
            let opcionesHtml = '<div class="quiz-options">';
            quiz.opciones.forEach((opcion, i) => {
                opcionesHtml += `<button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${quiz.respuesta_correcta}" data-tema="${quiz.tema}">${i + 1}. ${opcion}</button>`;
            });
            opcionesHtml += '</div>';
            const pregunta = `${quiz.pregunta}<br>Opciones:<br>${opcionesHtml}`;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(pregunta) : pregunta) + `<button class="copy-btn" data-text="${quiz.pregunta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
            container.appendChild(botDiv);
            scrollToBottom();
            guardarMensaje('Quiz', `${quiz.pregunta}\nOpciones: ${quiz.opciones.join(', ')}`);
            getElements('.quiz-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    const opcion = btn.dataset.opcion;
                    const respuestaCorrecta = btn.dataset.respuestaCorrecta;
                    const tema = btn.dataset.tema;
                    responderQuiz(opcion, respuestaCorrecta, tema);
                    getElements('.quiz-option').forEach(opt => opt.disabled = true);
                });
            });
            if (window.Prism) Prism.highlightAllUnder(container);
            addCopyButtonListeners();
        });
    } else {
        console.error('Botón #quiz-btn no encontrado');
        mostrarNotificacion('Error: Botón de quiz no encontrado', 'error');
    }

    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener('click', () => {
            console.log('Botón #new-chat-btn clicado');
            nuevaConversacion();
        });
    } else {
        console.error('Botón #new-chat-btn no encontrado');
        mostrarNotificacion('Error: Botón de nueva conversación no encontrado', 'error');
    }

    if (elements.clearBtn) {
        elements.clearBtn.addEventListener('click', () => {
            console.log('Botón #btn-clear clicado');
            limpiarChat();
        });
    } else {
        console.error('Botón #btn-clear no encontrado');
        mostrarNotificacion('Error: Botón de limpiar chat no encontrado', 'error');
    }

    if (elements.voiceBtn) {
        elements.voiceBtn.addEventListener('click', () => {
            console.log('Botón #voice-btn clicado');
            vozActiva = !vozActiva;
            elements.voiceBtn.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
            mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
            if (!vozActiva) stopSpeech();
        });
    } else {
        console.error('Botón #voice-btn no encontrado');
        mostrarNotificacion('Error: Botón de voz no encontrado', 'error');
    }

    if (elements.voiceToggleBtn) {
        elements.voiceToggleBtn.addEventListener('click', () => {
            console.log('Botón #voice-toggle-btn clicado');
            toggleVoiceRecognition();
        });
    } else {
        console.error('Botón #voice-toggle-btn no encontrado');
        mostrarNotificacion('Error: Botón de reconocimiento de voz no encontrado', 'error');
    }

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            console.log('Botón #modo-btn clicado');
            document.body.classList.toggle('modo-oscuro');
            const modo = document.body.classList.contains('modo-oscuro') ? 'Oscuro' : 'Claro';
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            localStorage.setItem('theme', modo.toLowerCase());
            mostrarNotificacion(`Modo ${modo} activado`, 'success');
        });
    } else {
        console.error('Botón #modo-btn no encontrado');
        mostrarNotificacion('Error: Botón de modo no encontrado', 'error');
    }

    if (elements.searchBtn && elements.searchInput) {
        elements.searchBtn.addEventListener('click', () => {
            console.log('Botón #search-btn clicado');
            buscarTema();
        });
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                console.log('Enter presionado en #search-input');
                buscarTema();
            }
        });
    } else {
        console.error('No se encontraron #search-btn o #search-input');
        mostrarNotificacion('Error: Botón o campo de búsqueda no encontrado', 'error');
    }

    if (elements.menuToggle && elements.menuToggleRight) {
        const toggleLeftMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Botón .menu-toggle clicado');
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (leftSection) {
                leftSection.classList.toggle('active');
                elements.menuToggle.innerHTML = `<i class="fas fa-${leftSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                if (rightSection && rightSection.classList.contains('active') && window.innerWidth <= 768) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        const toggleRightMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('Botón .menu-toggle-right clicado');
            const rightSection = getElement('.right-section');
            const leftSection = getElement('.left-section');
            if (rightSection) {
                rightSection.classList.toggle('active');
                elements.menuToggleRight.innerHTML = `<i class="fas fa-${rightSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                if (leftSection && leftSection.classList.contains('active') && window.innerWidth <= 768) {
                    leftSection.classList.remove('active');
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        elements.menuToggle.addEventListener('click', toggleLeftMenu);
        elements.menuToggle.addEventListener('touchstart', toggleLeftMenu, { passive: false });
        elements.menuToggleRight.addEventListener('click', toggleRightMenu);
        elements.menuToggleRight.addEventListener('touchstart', toggleRightMenu, { passive: false });

        const closeMenusOnOutsideInteraction = (e) => {
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (window.innerWidth <= 768) {
                if (leftSection && leftSection.classList.contains('active') &&
                    !leftSection.contains(e.target) &&
                    !elements.menuToggle.contains(e.target)) {
                    leftSection.classList.remove('active');
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                }
                if (rightSection && rightSection.classList.contains('active') &&
                    !rightSection.contains(e.target) &&
                    !elements.menuToggleRight.contains(e.target)) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        document.addEventListener('click', closeMenusOnOutsideInteraction);
        document.addEventListener('touchstart', closeMenusOnOutsideInteraction, { passive: false });
    } else {
        console.error('No se encontraron .menu-toggle o .menu-toggle-right');
        mostrarNotificacion('Error: Botones de menú no encontrados', 'error');
    }

    if (elements.tabButtons.length) {
        elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                console.log(`Botón .tab-btn con data-tab=${btn.dataset.tab} clicado`);
                elements.tabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
                getElement(`.${btn.dataset.tab}`)?.classList.add('active');
            });
        });
    }

    if (elements.searchInput) {
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                console.log('Enter presionado en #search-input');
                buscarTema();
            }
        });
    }

    document.querySelectorAll('.left-section button, .chat-actions button, .input-buttons button').forEach(btn => {
        const tooltipText = btn.dataset.tooltip;
        if (!tooltipText) return;
        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = tooltipText;
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'var(--bg-secondary, #fff)';
        tooltip.style.color = 'var(--text-primary, #333)';
        tooltip.style.padding = '5px 10px';
        tooltip.style.borderRadius = '4px';
        tooltip.style.fontSize = '12px';
        tooltip.style.zIndex = '10000';
        tooltip.style.opacity = '0';
        tooltip.style.visibility = 'hidden';
        tooltip.style.transition = 'opacity 0.3s ease, visibility 0.3s ease';
        tooltip.style.pointerEvents = 'none';
        document.body.appendChild(tooltip);
        btn.addEventListener('mouseenter', (e) => {
            const rect = btn.getBoundingClientRect();
            tooltip.style.top = `${rect.top + rect.height / 2}px`;
            tooltip.style.left = `${rect.left + rect.width + 10}px`;
            tooltip.style.transform = 'translateY(-50%)';
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });
        btn.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });
    });

    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'oscuro') {
        document.body.classList.add('modo-oscuro');
        if (elements.modoBtn) elements.modoBtn.innerHTML = `<i class="fas fa-sun"></i>`;
    } else {
        document.body.classList.remove('modo-oscuro');
        if (elements.modoBtn) elements.modoBtn.innerHTML = `<i class="fas fa-moon"></i>`;
    }

    console.log('Configuración de listeners completada');
});