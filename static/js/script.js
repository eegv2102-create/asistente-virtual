let vozActiva = true, isListening = false, recognition = null, voicesLoaded = false;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null; // Variable para almacenar el audio activo
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
    setTimeout(() => card.classList.remove('active', tipo), 5000);
};

const speakText = text => {
    if (!vozActiva || !text) return;
    fetch('/tts', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text})
    }).then(res => {
        if (!res.ok) throw new Error('Error en TTS');
        return res.blob();
    }).then(blob => {
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.play();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaElementSource(currentAudio);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const canvas = getElement('#lip-sync-canvas');
        const ctx = canvas?.getContext('2d');
        function draw() {
            if (!currentAudio.paused && ctx) {
                analyser.getByteFrequencyData(dataArray);
                let amplitude = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.beginPath();
                ctx.arc(25, 25, amplitude / 10, 0, 2 * Math.PI);
                ctx.fillStyle = 'red';
                ctx.fill();
                requestAnimationFrame(draw);
            }
        }
        if (canvas) draw();
    }).catch(error => {
        console.error('TTS /tts falló, usando speechSynthesis fallback', error);
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        speechSynthesis.speak(utterance);
        currentAudio = utterance; // Guardar utterance como audio activo
    });
};

const pauseSpeech = () => {
    if (currentAudio instanceof Audio) {
        currentAudio.pause();
        mostrarNotificacion('Voz pausada', 'info');
    } else if ('speechSynthesis' in window && currentAudio) {
        speechSynthesis.pause();
        mostrarNotificacion('Voz pausada', 'info');
    }
};

const stopSpeech = () => {
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
            const btnStartVoice = getElement('#btn-start-voice');
            const btnStopVoice = getElement('#btn-stop-voice');
            const btnPauseSpeech = getElement('#btn-pause-speech');
            if (btnStartVoice && btnStopVoice && btnPauseSpeech) {
                btnStartVoice.disabled = false;
                btnStopVoice.disabled = true;
                btnPauseSpeech.disabled = true;
            }
            mostrarNotificacion('Voz y reconocimiento detenidos', 'info');
        } catch (error) {
            mostrarNotificacion(`Error al detener voz: ${error.message}`, 'error');
        }
    }
};

const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) {
        console.error('Elemento .avatar-options no encontrado');
        return;
    }
    try {
        const response = await fetch('/avatars');
        if (!response.ok) throw new Error('Error en la respuesta del servidor');
        const avatares = await response.json();
        avatarContainer.innerHTML = '';
        avatares.forEach(avatar => {
            const img = document.createElement('img');
            img.src = avatar.url;
            img.classList.add('avatar-option');
            img.dataset.avatar = avatar.avatar_id;
            img.alt = avatar.nombre;
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
        li.innerHTML = `<span class="chat-name">${chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`}</span>
                        <div class="chat-actions">
                            <button class="rename-btn" aria-label="Renombrar">✏️</button>
                            <button class="delete-btn" aria-label="Eliminar">🗑️</button>
                        </div>`;
        li.dataset.index = index;
        li.setAttribute('aria-label', chat.nombre || `Chat ${new Date(chat.timestamp).toLocaleString()}`);
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
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) {
        console.error('Elemento .message-container no encontrado');
        return;
    }
    container.innerHTML = chat.mensajes.map(msg => `<div class="user">${msg.pregunta}</div><div class="bot">${msg.video_url ? `<img src="${msg.video_url}" alt="Avatar">` : marked.parse(msg.respuesta)}<button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje">📋</button></div>`).join('');
    container.scrollTop = container.scrollHeight;
    localStorage.setItem('currentConversation', JSON.stringify({ id: index, nombre: chat.nombre, timestamp: chat.timestamp, mensajes: chat.mensajes }));
    getElements('#chat-list li').forEach(li => li.classList.remove('selected'));
    getElement(`#chat-list li[data-index="${index}"]`)?.classList.add('selected');
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const renombrarChat = index => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
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
    }
};

const eliminarChat = index => {
    if (!confirm('¿Eliminar este chat?')) return;
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    historial.splice(index, 1);
    localStorage.setItem('chatHistory', JSON.stringify(historial));
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (currentConversation.id === index) {
        localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
        nuevaConversacion();
    }
    actualizarListaChats();
};

const nuevaConversacion = () => {
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (container) container.innerHTML = '';
    const input = getElement('#input');
    if (input) input.value = '';
    localStorage.setItem('currentConversation', JSON.stringify({ id: null, mensajes: [] }));
    mostrarNotificacion('Nuevo chat creado', 'success');
};

const limpiarChat = () => {
    nuevaConversacion();
};

const cargarConversacionActual = () => {
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container || !currentConversation.mensajes?.length) return;
    container.innerHTML = currentConversation.mensajes.map(msg => `<div class="user">${msg.pregunta}</div><div class="bot">${msg.video_url ? `<img src="${msg.video_url}" alt="Avatar">` : marked.parse(msg.respuesta)}<button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje">📋</button></div>`).join('');
    container.scrollTop = container.scrollHeight;
    if (window.Prism) Prism.highlightAll();
    addCopyButtonListeners();
};

const exportarTxt = () => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.mensajes.length) {
        mostrarNotificacion('No hay mensajes para exportar', 'error');
        return;
    }
    const text = currentConversation.mensajes.map(msg => `Pregunta: ${msg.pregunta}\nRespuesta: ${msg.respuesta}\n`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_${new Date().toLocaleString().replace(/[,:/]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    mostrarNotificacion('Chat exportado a TXT', 'success');
};

const exportarPdf = () => {
    const historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{"id": null, "mensajes": []}');
    if (!currentConversation.mensajes.length) {
        mostrarNotificacion('No hay mensajes para exportar', 'error');
        return;
    }
    const doc = new jsPDF();
    doc.setFontSize(12);
    let y = 10;
    currentConversation.mensajes.forEach(msg => {
        doc.text(`Pregunta: ${msg.pregunta}`, 10, y);
        y += 10;
        let respuesta = msg.respuesta.replace(/[\r\n]+/g, ' ').substring(0, 200);
        doc.text(`Respuesta: ${respuesta}`, 10, y);
        y += 20;
        if (y > 270) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save(`chat_${new Date().toLocaleString().replace(/[,:/]/g, '-')}.pdf`);
    mostrarNotificacion('Chat exportado a PDF', 'success');
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Mensaje copiado al portapapeles', 'success');
            }).catch(error => {
                mostrarNotificacion(`Error al copiar: ${error.message}`, 'error');
            });
        });
    });
};

const sendMessage = () => {
    const input = getElement('#input');
    const pregunta = input?.value.trim();
    if (!pregunta) return;
    input.value = '';
    const container = getElement('#chatbox')?.querySelector('.message-container');
    if (!container) {
        console.error('Elemento .message-container no encontrado');
        return;
    }
    const userDiv = document.createElement('div');
    userDiv.classList.add('user');
    userDiv.textContent = pregunta;
    container.appendChild(userDiv);
    container.scrollTop = container.scrollHeight;

    fetch('/respuesta', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({pregunta, usuario: 'anonimo', avatar_id: selectedAvatar, max_length: 200})
    }).then(res => {
        if (res.headers.get('content-type') === 'text/event-stream') {
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot', 'typing');
            container.appendChild(botDiv);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let respuesta = '';
            function read() {
                reader.read().then(({done, value}) => {
                    if (done) {
                        botDiv.classList.remove('typing');
                        botDiv.innerHTML = marked.parse(respuesta) + `<button class="copy-btn" data-text="${respuesta}" aria-label="Copiar mensaje">📋</button>`;
                        if (window.Prism) Prism.highlightAllUnder(botDiv);
                        speakText(respuesta);
                        guardarMensaje(pregunta, respuesta);
                        container.scrollTop = container.scrollHeight;
                        addCopyButtonListeners();
                        return;
                    }
                    const chunk = decoder.decode(value);
                    respuesta += chunk;
                    botDiv.innerHTML = marked.parse(respuesta);
                    container.scrollTop = container.scrollHeight;
                    read();
                }).catch(error => {
                    botDiv.classList.remove('typing');
                    mostrarNotificacion(`Error en streaming: ${error.message}`, 'error');
                });
            }
            read();
        } else {
            res.json().then(data => {
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                } else {
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    let respuestaHtml = marked.parse(data.respuesta);
                    if (data.sugerencias?.length) {
                        respuestaHtml += `<div class="suggestions"><strong>¿Qué más quieres saber?</strong> ${data.sugerencias.map(tema => `<a href="#" onclick="document.querySelector('#search-input').value='${tema}'; buscarTema(); return false;">${tema}</a>`).join('')}</div>`;
                    }
                    botDiv.innerHTML = respuestaHtml + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje">📋</button>`;
                    container.appendChild(botDiv);
                    if (window.Prism) Prism.highlightAllUnder(botDiv);
                    speakText(data.respuesta);
                    guardarMensaje(pregunta, data.respuesta);
                    container.scrollTop = container.scrollHeight;
                    addCopyButtonListeners();
                }
            }).catch(error => {
                mostrarNotificacion(`Error al procesar respuesta: ${error.message}`, 'error');
            });
        }
    }).catch(error => {
        mostrarNotificacion(`Error al enviar mensaje: ${error.message}`, 'error');
    });
};

const buscarTema = () => {
    const query = getElement('#search-input')?.value.trim().toLowerCase();
    if (!query) {
        mostrarNotificacion('Ingresa una palabra clave para buscar.', 'error');
        return;
    }
    fetch('/respuesta', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({pregunta: `Explica ${query}`, usuario: 'anonimo', avatar_id: selectedAvatar, max_length: 200})
    }).then(res => {
        if (res.headers.get('content-type') === 'text/event-stream') {
            const container = getElement('#chatbox')?.querySelector('.message-container');
            if (!container) return;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot', 'typing');
            container.appendChild(botDiv);
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let respuesta = '';
            function read() {
                reader.read().then(({done, value}) => {
                    if (done) {
                        botDiv.classList.remove('typing');
                        botDiv.innerHTML = marked.parse(respuesta) + `<button class="copy-btn" data-text="${respuesta}" aria-label="Copiar mensaje">📋</button>`;
                        if (window.Prism) Prism.highlightAllUnder(botDiv);
                        speakText(respuesta);
                        guardarMensaje(`Explica ${query}`, respuesta);
                        container.scrollTop = container.scrollHeight;
                        addCopyButtonListeners();
                        return;
                    }
                    const chunk = decoder.decode(value);
                    respuesta += chunk;
                    botDiv.innerHTML = marked.parse(respuesta);
                    container.scrollTop = container.scrollHeight;
                    read();
                }).catch(error => {
                    botDiv.classList.remove('typing');
                    mostrarNotificacion(`Error en búsqueda streaming: ${error.message}`, 'error');
                });
            }
            read();
        } else {
            res.json().then(data => {
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                } else {
                    const container = getElement('#chatbox')?.querySelector('.message-container');
                    if (!container) return;
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    let respuestaHtml = marked.parse(data.respuesta);
                    if (data.sugerencias?.length) {
                        respuestaHtml += `<div class="suggestions"><strong>¿Qué más quieres saber?</strong> ${data.sugerencias.map(tema => `<a href="#" onclick="document.querySelector('#search-input').value='${tema}'; buscarTema(); return false;">${tema}</a>`).join('')}</div>`;
                    }
                    botDiv.innerHTML = respuestaHtml + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje">📋</button>`;
                    container.appendChild(botDiv);
                    if (window.Prism) Prism.highlightAllUnder(botDiv);
                    speakText(data.respuesta);
                    guardarMensaje(`Explica ${query}`, data.respuesta);
                    container.scrollTop = container.scrollHeight;
                    addCopyButtonListeners();
                }
            }).catch(error => {
                mostrarNotificacion(`Error en búsqueda: ${error.message}`, 'error');
            });
        }
    }).catch(error => {
        mostrarNotificacion(`Error en búsqueda: ${error.message}`, 'error');
    });
};

const responderQuiz = (opcion, respuesta_correcta, tema) => {
    fetch('/responder_quiz', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({respuesta: opcion, respuesta_correcta, tema, usuario: 'anonimo'})
    }).then(res => res.json())
        .then(data => {
            const container = getElement('#chatbox')?.querySelector('.message-container');
            if (!container) return;
            const botDiv = document.createElement('div');
            botDiv.classList.add('bot');
            botDiv.innerHTML = marked.parse(data.respuesta) + `<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje">📋</button>`;
            container.appendChild(botDiv);
            if (window.Prism) Prism.highlightAllUnder(botDiv);
            speakText(data.respuesta);
            guardarMensaje(`Respuesta Quiz ${tema}`, data.respuesta);
            container.scrollTop = container.scrollHeight;
            addCopyButtonListeners();
        }).catch(error => {
            mostrarNotificacion(`Error en quiz: ${error.message}`, 'error');
        });
};

const cargarAnalytics = () => {
    fetch('/analytics?usuario=anonimo')
        .then(res => {
            if (!res.ok) {
                throw new Error(`Error en /analytics: ${res.status} ${res.statusText}`);
            }
            return res.json();
        })
        .then(data => {
            const container = getElement('#analytics-container');
            if (!container) {
                console.error('Elemento #analytics-container no encontrado');
                return;
            }
            if (!Array.isArray(data)) {
                console.error('Error al cargar analytics: data no es un arreglo', data);
                mostrarNotificacion('No se pudieron cargar las estadísticas. Intenta de nuevo.', 'error');
                container.innerHTML = '<p>No hay estadísticas disponibles.</p>';
                return;
            }
            container.innerHTML = data.map(item => `
                <div class="progress-bar">
                    <span>${item.tema}: ${Math.round(item.tasa_acierto * 100)}%</span>
                    <div class="bar" style="width: ${item.tasa_acierto * 100}%"></div>
                </div>
            `).join('');
        })
        .catch(error => {
            console.error('Error al cargar analytics:', error);
            mostrarNotificacion(`Error al cargar analytics: ${error.message}`, 'error');
            const container = getElement('#analytics-container');
            if (container) {
                container.innerHTML = '<p>Error al cargar estadísticas.</p>';
            }
        });
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        input: getElement('#input'),
        sendBtn: getElement('#send-btn'),
        voiceBtn: getElement('#voice-btn'),
        btnStartVoice: getElement('#btn-start-voice'),
        btnStopVoice: getElement('#btn-stop-voice'),
        btnPauseSpeech: getElement('#btn-pause-speech'),
        chatbox: getElement('#chatbox'),
        toggleAprendizajeBtn: getElement('#toggle-aprendizaje-btn'),
        modoBtn: getElement('#modo-btn'),
        exportTxtBtn: getElement('#export-txt-btn'),
        exportPdfBtn: getElement('#export-pdf-btn'),
        clearBtn: getElement('#limpiar-chat'),
        newChatBtn: getElement('#nueva-conversacion'),
        quizBtn: getElement('#quiz-btn'),
        menuToggle: getElement('.menu-toggle'),
        searchBtn: getElement('#search-btn'),
        searchInput: getElement('#search-input'),
        tabButtons: getElements('.tab-btn'),
        nivelBtns: getElements('.nivel-btn'),
        toggleRightSection: getElement('#toggle-right-section') // Nuevo elemento para toggle right-section
    };

    Object.entries(elements).forEach(([key, value]) => {
        if (!value && key !== 'tabButtons' && key !== 'nivelBtns') console.warn(`Elemento ${key} no encontrado en el DOM`);
    });

    cargarAvatares();
    actualizarListaChats();
    cargarConversacionActual();
    cargarAnalytics();

    if (elements.sendBtn && elements.input) {
        elements.sendBtn.addEventListener('click', sendMessage);
        elements.input.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
    } else {
        console.error('sendBtn o input no encontrados');
    }

    if (elements.clearBtn) {
        elements.clearBtn.addEventListener('click', limpiarChat);
    }

    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener('click', nuevaConversacion);
    }

    if (elements.searchBtn && elements.searchInput) {
        elements.searchBtn.addEventListener('click', buscarTema);
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') buscarTema();
        });
    }

    if (elements.quizBtn && elements.chatbox) {
        elements.quizBtn.addEventListener('click', () => {
            fetch('/quiz?usuario=anonimo')
                .then(res => res.json())
                .then(data => {
                    const container = elements.chatbox.querySelector('.message-container');
                    if (!container) return;
                    let opcionesHtml = '<div class="quiz-options">';
                    data.opciones.forEach((opcion, i) => {
                        opcionesHtml += `<button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${data.respuesta_correcta}" data-tema="${data.tema}">${i + 1}. ${opcion}</button>`;
                    });
                    opcionesHtml += '</div>';
                    const pregunta = `${data.pregunta}<br>Opciones:<br>${opcionesHtml}`;
                    container.innerHTML += `<div class="bot">${marked.parse(pregunta)}<button class="copy-btn" data-text="${data.pregunta}" aria-label="Copiar mensaje">📋</button></div>`;
                    container.scrollTop = container.scrollHeight;
                    guardarMensaje('Quiz', `${data.pregunta}\nOpciones: ${data.opciones.join(', ')}`);
                    getElements('.quiz-option').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const opcion = btn.dataset.opcion;
                            const respuesta_correcta = btn.dataset.respuestaCorrecta;
                            const tema = btn.dataset.tema;
                            responderQuiz(opcion, respuesta_correcta, tema);
                            getElements('.quiz-option').forEach(b => b.disabled = true);
                        });
                    });
                    if (window.Prism) Prism.highlightAllUnder(container);
                    addCopyButtonListeners();
                }).catch(error => mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error'));
        });
    }

    if (elements.exportTxtBtn) {
        elements.exportTxtBtn.addEventListener('click', exportarTxt);
    }

    if (elements.exportPdfBtn) {
        elements.exportPdfBtn.addEventListener('click', exportarPdf);
    }

    if (elements.menuToggle) {
        elements.menuToggle.addEventListener('click', () => {
            const leftSection = getElement('.left-section');
            if (leftSection) leftSection.classList.toggle('active');
        });
    }

    if (elements.toggleRightSection) {
        elements.toggleRightSection.addEventListener('click', () => {
            const rightSection = getElement('.right-section');
            if (rightSection) rightSection.classList.toggle('active');
        });
    }

    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'es-ES';

        const loadVoices = () => {
            const voices = speechSynthesis.getVoices();
            if (voices.length) {
                voicesLoaded = true;
            } else {
                setTimeout(loadVoices, 100);
            }
        };

        if ('speechSynthesis' in window) {
            loadVoices();
            speechSynthesis.onvoiceschanged = loadVoices;
        } else {
            vozActiva = false;
            mostrarNotificacion('Síntesis de voz no soportada.', 'error');
        }

        if (elements.btnStartVoice) {
            elements.btnStartVoice.addEventListener('click', () => {
                if (!isListening && recognition) {
                    try {
                        recognition.start();
                        isListening = true;
                        elements.btnStartVoice.disabled = true;
                        elements.btnStopVoice.disabled = false;
                        elements.btnPauseSpeech.disabled = false;
                        mostrarNotificacion('Escuchando...', 'info');
                    } catch (error) {
                        mostrarNotificacion(`Error al iniciar voz: ${error.message}`, 'error');
                        isListening = false;
                        elements.btnStartVoice.disabled = false;
                        elements.btnStopVoice.disabled = true;
                        elements.btnPauseSpeech.disabled = true;
                    }
                }
            });
        }

        if (elements.btnStopVoice) {
            elements.btnStopVoice.addEventListener('click', stopSpeech);
        }

        if (elements.btnPauseSpeech) {
            elements.btnPauseSpeech.addEventListener('click', pauseSpeech);
        }

        recognition.onstart = () => {
            isListening = true;
            elements.btnStartVoice.disabled = true;
            elements.btnStopVoice.disabled = false;
            elements.btnPauseSpeech.disabled = false;
            mostrarNotificacion('Reconocimiento de voz iniciado', 'info');
        };

        recognition.onresult = event => {
            const transcript = event.results[0][0].transcript;
            if (transcript.length > 500) {
                mostrarNotificacion('La transcripción excede los 500 caracteres.', 'error');
                return;
            }
            elements.input.value = transcript;
            sendMessage();
            isListening = false;
            elements.btnStartVoice.disabled = false;
            elements.btnStopVoice.disabled = true;
            elements.btnPauseSpeech.disabled = true;
            mostrarNotificacion(`Transcripción: ${transcript}`, 'info');
        };

        recognition.onerror = event => {
            let errorMsg = 'Error de voz desconocido';
            switch (event.error) {
                case 'no-speech':
                    errorMsg = 'No se detectó voz.';
                    break;
                case 'audio-capture':
                    errorMsg = 'No se pudo acceder al micrófono.';
                    break;
                case 'not-allowed':
                    errorMsg = 'Permiso de micrófono denegado.';
                    break;
                case 'network':
                    errorMsg = 'Error de red.';
                    break;
            }
            mostrarNotificacion(errorMsg, 'error');
            isListening = false;
            elements.btnStartVoice.disabled = false;
            elements.btnStopVoice.disabled = true;
            elements.btnPauseSpeech.disabled = true;
        };

        recognition.onend = () => {
            isListening = false;
            elements.btnStartVoice.disabled = false;
            elements.btnStopVoice.disabled = true;
            elements.btnPauseSpeech.disabled = true;
        };

        if (elements.voiceBtn) {
            elements.voiceBtn.addEventListener('click', () => {
                vozActiva = !vozActiva;
                elements.voiceBtn.textContent = vozActiva ? '🔊' : '🔇';
                mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'info');
                if (!vozActiva) stopSpeech();
                else if (voicesLoaded && elements.chatbox) {
                    const lastBotMessage = elements.chatbox.querySelector('.bot:last-child');
                    if (lastBotMessage && !lastBotMessage.querySelector('img')) {
                        const text = lastBotMessage.textContent.replace(/🤖\s*/, '').trim();
                        speakText(text);
                    }
                }
            });
        }
    } else {
        if (elements.voiceBtn) {
            elements.voiceBtn.disabled = true;
            elements.voiceBtn.setAttribute('aria-label', 'Reconocimiento de voz no soportado');
        }
        if (elements.btnStartVoice) elements.btnStartVoice.disabled = true;
        if (elements.btnStopVoice) elements.btnStopVoice.disabled = true;
        if (elements.btnPauseSpeech) elements.btnPauseSpeech.disabled = true;
        mostrarNotificacion('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge para esta función.', 'error');
    }

    elements.tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            elements.tabButtons.forEach(btn => btn.classList.remove('active'));
            getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
            button.classList.add('active');
            const tabContent = getElement(`.${button.dataset.tab}`);
            if (tabContent) tabContent.classList.add('active');
            if (button.dataset.tab === 'historial') cargarAnalytics();
        });
    });

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            localStorage.setItem('modo', document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro');
            mostrarNotificacion(`Modo cambiado a ${document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro'}`, 'success');
        });
        if (localStorage.getItem('modo') === 'claro') {
            document.body.classList.add('modo-claro');
        }
    }

    if (elements.nivelBtns.length > 0) {
        elements.nivelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const nivel = btn.dataset.nivel;
                document.body.className = `nivel-${nivel}`;
                elements.nivelBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                localStorage.setItem('nivel', nivel);
                fetch('/actualizar_nivel', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({nivel, usuario: 'anonimo'})
                }).then(res => res.json())
                    .then(data => mostrarNotificacion(data.mensaje, 'success'))
                    .catch(error => mostrarNotificacion(`Error al actualizar nivel: ${error.message}`, 'error'));
            });
        });
        const nivelGuardado = localStorage.getItem('nivel');
        if (nivelGuardado) {
            document.body.className = `nivel-${nivelGuardado}`;
            getElement(`.nivel-btn[data-nivel="${nivelGuardado}"]`)?.classList.add('active');
        }
    }

    if (elements.toggleAprendizajeBtn) {
        elements.toggleAprendizajeBtn.addEventListener('click', () => {
            const aprendizajeCard = getElement('#aprendizajeCard');
            if (aprendizajeCard) {
                aprendizajeCard.classList.toggle('active');
                mostrarNotificacion(`Modo aprendizaje ${aprendizajeCard.classList.contains('active') ? 'activado' : 'desactivado'}`, 'success');
            }
        });
    }

    const learnBtn = getElement('#learnBtn');
    if (learnBtn) {
        learnBtn.addEventListener('click', () => {
            const nuevaPregunta = getElement('#nuevaPregunta')?.value.trim();
            const nuevaRespuesta = getElement('#nuevaRespuesta')?.value.trim();
            if (!nuevaPregunta || !nuevaRespuesta) {
                mostrarNotificacion('Pregunta y respuesta no pueden estar vacías', 'error');
                return;
            }
            fetch('/aprendizaje', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({pregunta: nuevaPregunta, respuesta: nuevaRespuesta})
            }).then(res => res.json())
                .then(data => {
                    if (data.mensaje) {
                        mostrarNotificacion(data.mensaje, 'success');
                        getElement('#aprendizajeCard')?.classList.remove('active');
                    } else {
                        mostrarNotificacion(data.error, 'error');
                    }
                }).catch(error => mostrarNotificacion(`Error al aprender: ${error.message}`, 'error'));
        });
    }
});
