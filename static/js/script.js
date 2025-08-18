let vozActiva = true, isListening = false, recognition = null, voicesLoaded = false;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
const { jsPDF } = window.jspdf;

const getElement = selector => document.querySelector(selector);
const getElements = selector => document.querySelectorAll(selector);

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
        if (window.innerWidth <= 768) {
            chatbox.scrollTop = chatbox.scrollHeight;
        }
    });
};

const speakText = text => {
    if (!vozActiva || !text) return;
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.add('speaking');
    fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    }).then(res => {
        if (!res.ok) throw new Error('Error en TTS');
        return res.blob();
    }).then(blob => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaElementSource(currentAudio);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8-bit array(bufferLength);
        const canvas = getElement('#lip-sync-canvas');
        const ctx = canvas?.getContext('2d');
        function draw() {
            if (currentAudio && !currentAudio.paused && !currentAudio.ended && ctx) {
                analyser.getByteFrequencyData(dataArray);
                let amplitude = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(25, 25, amplitude / 10, 0, 2 * Math.PI);
                ctx.fillStyle = 'red';
                ctx.fill();
                requestAnimationFrame(draw);
            } else if (botMessage) {
                botMessage.classList.remove('speaking');
                if (canvas) canvas.style.opacity = '0';
            }
        }
        if (canvas) {
            canvas.style.opacity = '1';
            draw();
        }
        currentAudio.onended = () => {
            if (botMessage) botMessage.classList.remove('speaking');
            if (canvas) canvas.style.opacity = '0';
        };
    }).catch(error => {
        console.error('TTS /tts falló, usando speechSynthesis fallback', error);
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        utterance.onend = () => {
            if (botMessage) botMessage.classList.remove('speaking');
        };
        speechSynthesis.speak(utterance);
        currentAudio = utterance;
    });
};

const pauseSpeech = () => {
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        mostrarNotificacion('Voz pausada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = true;
            btnResumeSpeech.disabled = false;
        }
    } else if ('speechSynthesis' in window && currentAudio) {
        speechSynthesis.pause();
        mostrarNotificacion('Voz pausada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = true;
            btnResumeSpeech.disabled = false;
        }
    }
};

const resumeSpeech = () => {
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    if (currentAudio instanceof Audio) {
        currentAudio.play();
        mostrarNotificacion('Voz reanudada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = false;
            btnResumeSpeech.disabled = true;
        }
    } else if ('speechSynthesis' in window && currentAudio && speechSynthesis.paused) {
        speechSynthesis.resume();
        mostrarNotificacion('Voz reanudada', 'info');
        if (btnPauseSpeech && btnResumeSpeech) {
            btnPauseSpeech.disabled = false;
            btnResumeSpeech.disabled = true;
        }
    }
};

const stopSpeech = () => {
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
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
            if (btnStartVoice && btnStopVoice && btnPauseSpeech && btnResumeSpeech) {
                btnStartVoice.disabled = false;
                btnStopVoice.disabled = true;
                btnPauseSpeech.disabled = true;
                btnResumeSpeech.disabled = true;
            }
            mostrarNotificacion('Voz y reconocimiento detenidos', 'info');
        } catch (error) {
            mostrarNotificacion(`Error al detener voz: ${error.message}`, 'error');
        }
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
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
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
    } catch (error) {
        mostrarNotificacion(`Error al cargar avatares: ${error.message}`, 'error');
        console.error('Error al cargar avatares:', error);
        const fallbackAvatares = [
            { avatar_id: 'default', nombre: 'Default', url: '/static/img/default-avatar.png' },
            { avatar_id: 'poo', nombre: 'POO', url: '/static/img/poo.png' }
        ];
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
                mostrarNotificacion(`Avatar seleccionado: ${avatar.nombre}`, 'success');
            });
        });
    }
};

const guardarMensaje = (pregunta, respuesta, video_url = null) => {
    let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.id && currentConversation.id !== 0) {
        const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
        currentConversation = { id: historial.length, nombre: `Chat ${new Date().toLocaleString()}`, timestamp: Date.now(), mensajes: [] };
        historial.push({ nombre: currentConversation.nombre, timestamp: currentConversation.timestamp, mensajes: [] });
        localStorage.setItem('chatHistory', JSON.stringify(historial));
    }
    currentConversation.mensajes.push({ pregunta, respuesta, video_url });
    localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    historial[currentConversation.id].mensajes = currentConversation.mensajes;
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    actualizarListaChats();
};

const actualizarListaChats = () => {
    const chatList = getElement('#chat-list');
    if (!chatList) {
        console.error('Elemento #chat-list no encontrado');
        return;
    }
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    if (chatList.children.length === historial.length && !historial.some((chat, i) => chatList.children[i]?.dataset.index != i)) return;
    chatList.innerHTML = '';
    historial.forEach((chat, index) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date().toLocaleString()}`}</span> <div class="chat-actions"> <button class="rename-btn" aria-label="Renombrar"><i class="fas fa-edit"></i></button> <button class="delete-btn" aria-label="Eliminar"><i class="fas fa-trash"></i></button> </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date().toLocaleString()}`);
        chatList.appendChild(li);
        li.addEventListener('click', e => e.target.tagName !== 'BUTTON' && cargarChat(index));
        li.querySelector('.rename-btn').addEventListener('click', () => renombrarChat(index));
        li.querySelector('.delete-btn').addEventListener('click', () => eliminarChat(index));
    });
    chatList.scrollTop = chatList.scrollHeight;
};

const cargarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const chat = historial[index];
    if (!chat) return;
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    container.innerHTML = '';
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, mensajes: chat.mensajes }));
    chat.mensajes.forEach(msg => {
        agregarMensaje(msg.pregunta, 'user');
        agregarMensaje(msg.respuesta, 'bot', msg.video_url);
    });
    scrollToBottom();
    mostrarNotificacion(`Cargando chat: ${chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`}`, 'info');
    getElements('#chat-list li').forEach(li => {
        li.classList.toggle('active', li.dataset.index == index);
    });
};

const agregarMensaje = (texto, remitente, video_url = null) => {
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (!container || !chatbox) {
        console.error('Elemento #chatbox o .message-container no encontrado');
        return;
    }
    const message = document.createElement('div');
    message.classList.add('message', `${remitente}-message`);

    let avatarSrc = '';
    let avatarAlt = '';
    if (remitente === 'user') {
        avatarSrc = '/static/img/user-avatar.png';
        avatarAlt = 'Avatar de Usuario';
    } else {
        avatarSrc = getElement(`.avatar-option[data-avatar="${selectedAvatar}"]`)?.src || '/static/img/default-avatar.png';
        avatarAlt = `Avatar de ${selectedAvatar}`;
    }

    let messageHtml = `
        <div class="avatar-container">
            <img src="${avatarSrc}" alt="${avatarAlt}" class="avatar">
            ${remitente === 'bot' ? `<canvas id="lip-sync-canvas"></canvas>` : ''}
        </div>
        <div class="content">${marked.parse(texto)}</div>
    `;

    if (video_url) {
        messageHtml += `
            <a href="${video_url}" target="_blank" rel="noopener noreferrer" class="video-link">
                Ver Video Relacionado
            </a>
        `;
    }

    message.innerHTML = messageHtml;
    container.appendChild(message);
    Prism.highlightAll();
    scrollToBottom();
    if (remitente === 'bot') {
        speakText(texto);
    }
};

const enviarMensaje = async (e) => {
    e.preventDefault();
    const userInput = getElement('#userInput');
    const mensaje = userInput.value.trim();
    if (!mensaje) return;

    // Deshabilitar botones mientras se procesa
    const btnSend = getElement('#send-btn');
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    if (btnSend) btnSend.disabled = true;
    if (btnStartVoice) btnStartVoice.disabled = true;
    if (btnStopVoice) btnStopVoice.disabled = true;
    if (btnPauseSpeech) btnPauseSpeech.disabled = true;
    if (btnResumeSpeech) btnResumeSpeech.disabled = true;

    agregarMensaje(mensaje, 'user');
    userInput.value = '';
    mostrarNotificacion('Pensando...', 'info');

    try {
        const nivel = document.body.classList.contains('nivel-basico') ? 'basico' :
                      document.body.classList.contains('nivel-intermedio') ? 'intermedio' :
                      'avanzado';
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: mensaje, nivel: nivel })
        });

        if (!response.ok) {
            throw new Error(`Error en la respuesta del servidor: ${response.status}`);
        }

        const data = await response.json();
        const respuesta = data.response;
        const video_url = data.video_url;

        agregarMensaje(respuesta, 'bot', video_url);
        guardarMensaje(mensaje, respuesta, video_url);
        mostrarNotificacion('Respuesta recibida', 'success');
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        agregarMensaje("Lo siento, hubo un error al procesar tu solicitud. Por favor, intenta de nuevo.", 'bot');
        mostrarNotificacion('Error en la comunicación', 'error');
    } finally {
        // Habilitar botones
        if (btnSend) btnSend.disabled = false;
        if (btnStartVoice) btnStartVoice.disabled = false;
        if (btnStopVoice) btnStopVoice.disabled = false;
        if (btnPauseSpeech) btnPauseSpeech.disabled = false;
        if (btnResumeSpeech) btnResumeSpeech.disabled = false;
    }
};

const newChat = () => {
    localStorage.removeItem('currentConversation');
    const chatbox = getElement('#chatbox');
    const container = chatbox?.querySelector('.message-container');
    if (container) {
        container.innerHTML = '';
    }
    actualizarListaChats();
    mostrarNotificacion('Nuevo chat iniciado', 'success');
};

const eliminarChat = () => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null}');
    const index = currentConversation.id;

    if (index !== null) {
        historial.splice(index, 1);
        localStorage.setItem('chatHistory', JSON.stringify(historial));
        newChat();
        mostrarNotificacion('Chat eliminado', 'success');
    } else {
        mostrarNotificacion('No hay chat para eliminar', 'error');
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = getElement('#send-btn');
    const userInput = getElement('#userInput');
    const newChatBtn = getElement('#new-chat-btn');
    const deleteChatBtn = getElement('#delete-chat-btn');
    const exportPdfBtn = getElement('#exportPdfBtn');
    const exportTxtBtn = getElement('#exportTxtBtn');
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    const btnPauseSpeech = getElement('#btn-pause-speech');
    const btnResumeSpeech = getElement('#btn-resume-speech');
    const quizBtn = getElement('#quiz-btn');
    const recommendBtn = getElement('#recommend-btn');

    if (sendBtn) sendBtn.addEventListener('click', enviarMensaje);
    if (userInput) userInput.addEventListener('keypress', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            enviarMensaje(e);
        }
    });

    if (newChatBtn) newChatBtn.addEventListener('click', newChat);
    if (deleteChatBtn) deleteChatBtn.addEventListener('click', eliminarChat);

    if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportarPdf);
    if (exportTxtBtn) exportTxtBtn.addEventListener('click', exportarTxt);
    if (btnStartVoice) btnStartVoice.addEventListener('click', iniciarReconocimiento);
    if (btnStopVoice) btnStopVoice.addEventListener('click', detenerReconocimiento);
    if (btnPauseSpeech) btnPauseSpeech.addEventListener('click', pauseSpeech);
    if (btnResumeSpeech) btnResumeSpeech.addEventListener('click', resumeSpeech);
    if (quizBtn) quizBtn.addEventListener('click', generarQuiz);
    if (recommendBtn) recommendBtn.addEventListener('click', buscarTema);
    
    // Funcionalidad de tooltips.
    // Usamos el evento 'mouseover' en el padre para manejar los tooltips de forma eficiente.
    const tooltip = document.createElement('div');
    tooltip.className = 'custom-tooltip';
    document.body.appendChild(tooltip);

    document.body.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            const tooltipText = target.dataset.tooltip;
            tooltip.textContent = tooltipText;
            const rect = target.getBoundingClientRect();
            tooltip.style.left = `${rect.left + rect.width / 2}px`;
            tooltip.style.top = `${rect.top}px`;
            tooltip.style.transform = 'translate(-50%, -120%)';
            tooltip.classList.add('active');
        }
    });

    document.body.addEventListener('mouseout', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            tooltip.classList.remove('active');
        }
    });
});

const renombrarChat = (index) => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const chat = historial[index];
    if (!chat) return;

    const newName = prompt('Ingrese el nuevo nombre para el chat:', chat.nombre);
    if (newName && newName.trim() !== '') {
        chat.nombre = newName;
        localStorage.setItem('chatHistory', JSON.stringify(historial));
        actualizarListaChats();
        mostrarNotificacion(`Chat renombrado a "${newName}"`, 'success');
    }
};

const exportarPdf = async () => {
    const chatbox = getElement('#chatbox');
    const pdf = new jsPDF();
    pdf.setFont('helvetica');
    pdf.setFontSize(10);
    pdf.setLineHeightFactor(1.5);
    let y = 10;
    const padding = 10;
    const margin = 10;
    const maxWidth = pdf.internal.pageSize.getWidth() - 2 * margin;

    const messages = chatbox.querySelectorAll('.message-container .message');
    messages.forEach(msg => {
        const remitente = msg.classList.contains('user-message') ? 'Tú: ' : 'Asistente: ';
        const content = msg.querySelector('.content').textContent.trim();
        let lines = pdf.splitTextToSize(`${remitente}${content}`, maxWidth - padding);
        if (y + lines.length * 10 > pdf.internal.pageSize.getHeight() - margin) {
            pdf.addPage();
            y = 10;
        }
        pdf.text(lines, margin, y);
        y += lines.length * 10;
    });
    pdf.save('chat.pdf');
    mostrarNotificacion('Chat exportado a PDF', 'success');
};

const exportarTxt = () => {
    const chatbox = getElement('#chatbox');
    let textContent = '';
    const messages = chatbox.querySelectorAll('.message-container .message');
    messages.forEach(msg => {
        const remitente = msg.classList.contains('user-message') ? 'Tú: ' : 'Asistente: ';
        const content = msg.querySelector('.content').textContent.trim();
        textContent += `${remitente}${content}\n\n`;
    });
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chat.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    mostrarNotificacion('Chat exportado a TXT', 'success');
};

const iniciarReconocimiento = () => {
    const btnStartVoice = getElement('#btn-start-voice');
    const btnStopVoice = getElement('#btn-stop-voice');
    if (!('webkitSpeechRecognition' in window)) {
        mostrarNotificacion('El reconocimiento de voz no es compatible con este navegador.', 'error');
        return;
    }
    recognition = new webkitSpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onstart = () => {
        isListening = true;
        btnStartVoice.disabled = true;
        btnStopVoice.disabled = false;
        mostrarNotificacion('Escuchando...', 'info');
    };
    recognition.onresult = event => {
        const transcript = event.results[0][0].transcript;
        const userInput = getElement('#userInput');
        userInput.value = transcript;
        enviarMensaje({ preventDefault: () => {} });
    };
    recognition.onend = () => {
        isListening = false;
        btnStartVoice.disabled = false;
        btnStopVoice.disabled = true;
        mostrarNotificacion('Reconocimiento de voz detenido.', 'info');
    };
    recognition.onerror = event => {
        console.error('Error de reconocimiento de voz:', event.error);
        if (event.error === 'no-speech' || event.error === 'audio-capture') {
            mostrarNotificacion('No se detectó voz o hay un problema con el micrófono.', 'error');
        } else {
            mostrarNotificacion(`Error de voz: ${event.error}`, 'error');
        }
        isListening = false;
        btnStartVoice.disabled = false;
        btnStopVoice.disabled = true;
    };
    recognition.start();
};

const detenerReconocimiento = () => {
    if (isListening && recognition) {
        recognition.stop();
    }
};

const generarQuiz = async () => {
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation'));
    if (!currentConversation || currentConversation.mensajes.length === 0) {
        mostrarNotificacion('No hay conversación actual para generar un quiz.', 'error');
        return;
    }
    const nivel = document.body.classList.contains('nivel-basico') ? 'basico' :
                  document.body.classList.contains('nivel-intermedio') ? 'intermedio' :
                  'avanzado';
    const lastQuestion = currentConversation.mensajes[currentConversation.mensajes.length - 1].pregunta;
    mostrarNotificacion('Generando quiz...', 'info');
    try {
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Genera un quiz del tema: ${lastQuestion}`, nivel: nivel })
        });
        if (!response.ok) throw new Error('Error al generar quiz');
        const data = await response.json();
        agregarMensaje(data.response, 'bot');
    } catch (error) {
        mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
    }
};

const buscarTema = async () => {
    const userInput = getElement('#userInput');
    const mensaje = userInput.value.trim();
    if (!mensaje) {
        mostrarNotificacion('Por favor, introduce un tema para buscar.', 'error');
        return;
    }
    mostrarNotificacion('Buscando tema...', 'info');
    try {
        const nivel = document.body.classList.contains('nivel-basico') ? 'basico' :
                      document.body.classList.contains('nivel-intermedio') ? 'intermedio' :
                      'avanzado';
        const response = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Genera información sobre el tema: ${mensaje}`, nivel: nivel })
        });
        if (!response.ok) throw new Error('Error al buscar tema');
        const data = await response.json();
        agregarMensaje(data.response, 'bot');
    } catch (error) {
        mostrarNotificacion(`Error al buscar tema: ${error.message}`, 'error');
    }
};

window.onload = () => {
    cargarAvatares();
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation'));
    if (currentConversation && currentConversation.mensajes.length > 0) {
        cargarChat(currentConversation.id);
    } else {
        newChat();
    }
    actualizarListaChats();
    setupModoOscuro();
};

const setupModoOscuro = () => {
    const modoBtn = getElement('#modo-btn');
    const savedMode = localStorage.getItem('modo-claro');
    if (savedMode === 'true') {
        document.body.classList.add('modo-claro');
        modoBtn.innerHTML = '<i class="fas fa-moon"></i>';
    } else {
        document.body.classList.remove('modo-claro');
        modoBtn.innerHTML = '<i class="fas fa-sun"></i>';
    }
    modoBtn.addEventListener('click', () => {
        document.body.classList.toggle('modo-claro');
        const isLightMode = document.body.classList.contains('modo-claro');
        localStorage.setItem('modo-claro', isLightMode);
        modoBtn.innerHTML = isLightMode ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
    });
};

document.querySelectorAll('.nivel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const nivel = btn.dataset.nivel;
        document.body.classList.remove('nivel-basico', 'nivel-intermedio', 'nivel-avanzado');
        document.body.classList.add(`nivel-${nivel}`);
        localStorage.setItem('nivel', nivel);
        mostrarNotificacion(`Nivel cambiado a: ${nivel.charAt(0).toUpperCase() + nivel.slice(1)}`, 'info');
    });
});