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
        const dataArray = new Uint8Array(bufferLength);
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
        li.dataset.index = index;
        li.innerHTML = `
            <span>${chat.nombre}</span>
            <button class="load-chat" data-index="${index}">Cargar</button>
            <button class="delete-chat" data-index="${index}">Eliminar</button>
        `;
        chatList.appendChild(li);
    });
    getElements('.load-chat').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = btn.dataset.index;
            const chat = JSON.parse(localStorage.getItem('chatHistory'))[index];
            let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
            currentConversation.id = index;
            currentConversation.mensajes = chat.mensajes;
            currentConversation.nombre = chat.nombre;
            currentConversation.timestamp = chat.timestamp;
            localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
            const container = getElement('#chatbox .message-container');
            container.innerHTML = '';
            chat.mensajes.forEach(msg => {
                container.innerHTML += `<div class="user">${msg.pregunta}</div>`;
                container.innerHTML += `<div class="bot">${marked.parse(msg.respuesta)}<button class="copy-btn" data-text="${msg.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button></div>`;
            });
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(container);
            addCopyButtonListeners();
        });
    });
    getElements('.delete-chat').forEach(btn => {
        btn.addEventListener('click', () => {
            const index = btn.dataset.index;
            let historial = JSON.parse(localStorage.getItem('chatHistory') || '[]');
            historial.splice(index, 1);
            localStorage.setItem('chatHistory', JSON.stringify(historial));
            let currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
            if (currentConversation.id == index) {
                currentConversation = { id: null, mensajes: [] };
                localStorage.setItem('currentConversation', JSON.stringify(currentConversation));
                getElement('#chatbox .message-container').innerHTML = '';
            }
            actualizarListaChats();
        });
    });
};

const addCopyButtonListeners = () => {
    getElements('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.dataset.text;
            navigator.clipboard.writeText(text).then(() => {
                mostrarNotificacion('Texto copiado al portapapeles', 'success');
            }).catch(err => {
                mostrarNotificacion(`Error al copiar: ${err.message}`, 'error');
            });
        });
    });
};

const exportarTxt = () => {
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (!currentConversation.mensajes || currentConversation.mensajes.length === 0) {
        mostrarNotificacion('No hay mensajes para exportar', 'error');
        return;
    }
    let textContent = `Chat ${currentConversation.nombre}\n\n`;
    currentConversation.mensajes.forEach(msg => {
        textContent += `Usuario: ${msg.pregunta}\nAsistente: ${msg.respuesta}\n\n`;
    });
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_${currentConversation.nombre.replace(/\s+/g, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
};

const exportarPdf = () => {
    const currentConversation = JSON.parse(localStorage.getItem('currentConversation') || '{}');
    if (!currentConversation.mensajes || currentConversation.mensajes.length === 0) {
        mostrarNotificacion('No hay mensajes para exportar', 'error');
        return;
    }
    const doc = new jsPDF();
    doc.setFontSize(12);
    let y = 10;
    doc.text(`Chat ${currentConversation.nombre}`, 10, y);
    y += 10;
    currentConversation.mensajes.forEach(msg => {
        doc.text(`Usuario: ${msg.pregunta}`, 10, y);
        y += 7;
        const lines = doc.splitTextToSize(`Asistente: ${msg.respuesta}`, 180);
        doc.text(lines, 10, y);
        y += lines.length * 7 + 5;
        if (y > 280) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save(`chat_${currentConversation.nombre.replace(/\s+/g, '_')}.pdf`);
};

const sendMessage = () => {
    const input = getElement('#input');
    const container = getElement('#chatbox .message-container');
    if (!input || !container) {
        mostrarNotificacion('Error: Elementos de entrada o chat no encontrados', 'error');
        return;
    }
    const pregunta = input.value.trim();
    if (!pregunta) {
        mostrarNotificacion('Por favor, escribe una pregunta.', 'error');
        return;
    }
    container.innerHTML += `<div class="user">${pregunta}</div>`;
    scrollToBottom();
    fetch('/respuesta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta, usuario: 'anonimo', avatar_id: selectedAvatar })
    }).then(res => res.json())
        .then(data => {
            if (data.error) {
                mostrarNotificacion(data.error, 'error');
                return;
            }
            container.innerHTML += `<div class="bot">${marked.parse(data.respuesta)}<img src="${data.avatar_url}" alt="Avatar" class="selected-avatar"><button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button></div>`;
            scrollToBottom();
            if (window.Prism) Prism.highlightAllUnder(container);
            speakText(data.respuesta);
            guardarMensaje(pregunta, data.respuesta, data.avatar_url);
            addCopyButtonListeners();
        }).catch(error => {
            mostrarNotificacion(`Error al enviar mensaje: ${error.message}`, 'error');
        });
    input.value = '';
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        input: getElement('#input'),
        sendBtn: getElement('#send-btn'),
        chatbox: getElement('#chatbox'),
        voiceBtn: getElement('#voice-btn'),
        quizBtn: getElement('#quiz-btn'),
        recomendacionBtn: getElement('#recomendacion-btn'),
        nivelBtns: getElements('.nivel-btn'),
        modoBtn: getElement('#modo-btn'),
        btnStartVoice: getElement('#btn-start-voice'),
        btnStopVoice: getElement('#btn-stop-voice'),
        btnPauseSpeech: getElement('#btn-pause-speech'),
        btnResumeSpeech: getElement('#btn-resume-speech'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        toggleAprendizajeBtn: getElement('#toggleAprendizajeBtn'),
        exportTxtBtn: getElement('#exportTxtBtn'),
        exportPdfBtn: getElement('#exportPdfBtn')
    };

    Object.keys(elements).forEach(key => {
        if (!elements[key] && (key !== 'nivelBtns' || elements[key].length === 0)) {
            console.warn(`Elemento ${key} no encontrado en el DOM`);
        }
    });

    cargarAvatares();
    actualizarListaChats();

    if (elements.sendBtn) {
        elements.sendBtn.addEventListener('click', sendMessage);
        elements.input?.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
    }

    if (elements.quizBtn) {
        elements.quizBtn.addEventListener('click', () => {
            fetch('/quiz?usuario=anonimo')
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                        return;
                    }
                    const container = elements.chatbox.querySelector('.message-container');
                    container.innerHTML += `<div class="bot">${marked.parse(data.pregunta)}</div>`;
                    data.opciones.forEach(opcion => {
                        container.innerHTML += `<div class="bot"><button class="quiz-option" data-opcion="${opcion}" data-correcta="${data.respuesta_correcta}" data-tema="${data.tema}">${opcion}</button></div>`;
                    });
                    scrollToBottom();
                    getElements('.quiz-option').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const opcion = btn.dataset.opcion;
                            const correcta = btn.dataset.correcta;
                            const tema = btn.dataset.tema;
                            getElements('.quiz-option').forEach(b => b.disabled = true);
                            fetch('/responder_quiz', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ usuario: 'anonimo', respuesta: opcion, respuesta_correcta: correcta, tema })
                            }).then(res => res.json())
                                .then(data => {
                                    container.innerHTML += `<div class="bot">${marked.parse(data.respuesta)}<button class="copy-btn" data-text="${data.respuesta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button></div>`;
                                    scrollToBottom();
                                    guardarMensaje(`Respuesta quiz ${tema}`, data.respuesta);
                                    addCopyButtonListeners();
                                    setTimeout(() => elements.quizBtn.click(), 2000);
                                }).catch(error => {
                                    mostrarNotificacion(`Error al responder quiz: ${error.message}`, 'error');
                                });
                        });
                    });
                }).catch(error => {
                    mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
                });
        });
    }

    if (elements.recomendacionBtn) {
        elements.recomendacionBtn.addEventListener('click', () => {
            fetch('/recomendacion?usuario=anonimo')
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                        return;
                    }
                    const container = elements.chatbox.querySelector('.message-container');
                    container.innerHTML += `<div class="bot">Te recomiendo estudiar: ${data.recomendacion}</div>`;
                    scrollToBottom();
                    guardarMensaje('Recomendación', `Te recomiendo estudiar: ${data.recomendacion}`);
                }).catch(error => {
                    mostrarNotificacion(`Error al obtener recomendación: ${error.message}`, 'error');
                });
        });
    }

    if (elements.nivelBtns) {
        elements.nivelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const nivel = btn.dataset.nivel;
                document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
                elements.nivelBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                fetch('/actualizar_nivel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario: 'anonimo', nivel })
                }).then(res => res.json())
                    .then(data => {
                        mostrarNotificacion(data.mensaje || `Nivel cambiado a ${nivel}`, 'success');
                    }).catch(error => {
                        mostrarNotificacion(`Error al actualizar nivel: ${error.message}`, 'error');
                    });
            });
        });
    }

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            const modo = document.body.classList.contains('modo-claro') ? 'Claro' : 'Oscuro';
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            mostrarNotificacion(`Modo ${modo} activado`, 'success');
        });
    }

    if (elements.voiceBtn) {
        elements.voiceBtn.addEventListener('click', () => {
            vozActiva = !vozActiva;
            elements.voiceBtn.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
            mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'success');
            if (!vozActiva) stopSpeech();
        });
    }

    if (elements.btnStartVoice && elements.btnStopVoice && elements.btnPauseSpeech && elements.btnResumeSpeech) {
        elements.btnStartVoice.addEventListener('click', () => {
            if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
                mostrarNotificacion('Reconocimiento de voz no soportado. Usa un navegador compatible (e.g., Chrome).', 'error');
                return;
            }
            recognition = ('webkitSpeechRecognition' in window) ? new webkitSpeechRecognition() : new SpeechRecognition();
            recognition.lang = 'es-ES';
            recognition.interimResults = true;
            recognition.continuous = true;
            recognition.start();
            isListening = true;
            elements.btnStartVoice.disabled = true;
            elements.btnStopVoice.disabled = false;
            elements.btnPauseSpeech.disabled = true;
            elements.btnResumeSpeech.disabled = true;
            mostrarNotificacion('Reconocimiento de voz iniciado', 'success');

            recognition.onresult = event => {
                const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
                if (elements.input) elements.input.value = transcript;
                if (event.results[event.results.length - 1].isFinal) {
                    sendMessage();
                    recognition.stop();
                    isListening = false;
                    elements.btnStartVoice.disabled = false;
                    elements.btnStopVoice.disabled = true;
                }
            };

            recognition.onerror = event => {
                mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
                recognition.stop();
                isListening = false;
                elements.btnStartVoice.disabled = false;
                elements.btnStopVoice.disabled = true;
            };

            recognition.onend = () => {
                if (isListening) {
                    recognition.start();
                } else {
                    elements.btnStartVoice.disabled = false;
                    elements.btnStopVoice.disabled = true;
                }
            };
        });

        elements.btnStopVoice.addEventListener('click', stopSpeech);
        elements.btnPauseSpeech.addEventListener('click', pauseSpeech);
        elements.btnResumeSpeech.addEventListener('click', resumeSpeech);
    }

    if (elements.menuToggle && elements.menuToggleRight) {
        const toggleLeftMenu = (e) => {
            e.preventDefault();
            const leftSection = getElement('.left-section');
            if (leftSection) {
                leftSection.classList.toggle('active');
                elements.menuToggle.innerHTML = `<i class="fas fa-${leftSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                const rightSection = getElement('.right-section');
                if (rightSection && rightSection.classList.contains('active')) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        const toggleRightMenu = (e) => {
            e.preventDefault();
            const rightSection = getElement('.right-section');
            if (rightSection) {
                rightSection.classList.toggle('active');
                elements.menuToggleRight.innerHTML = `<i class="fas fa-${rightSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                const leftSection = getElement('.left-section');
                if (leftSection && leftSection.classList.contains('active')) {
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
            const menuToggle = getElement('.menu-toggle');
            const menuToggleRight = getElement('.menu-toggle-right');
            if (window.innerWidth <= 768) {
                if (leftSection && leftSection.classList.contains('active') &&
                    !leftSection.contains(e.target) &&
                    !menuToggle.contains(e.target)) {
                    leftSection.classList.remove('active');
                    leftSection.style.transform = 'translateX(-100%)';
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                }
                if (rightSection && rightSection.classList.contains('active') &&
                    !rightSection.contains(e.target) &&
                    !menuToggleRight.contains(e.target)) {
                    rightSection.classList.remove('active');
                    rightSection.style.transform = 'translateX(100%)';
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        document.addEventListener('click', closeMenusOnOutsideInteraction);
        document.addEventListener('touchstart', closeMenusOnOutsideInteraction, { passive: false });
    }

    if (elements.toggleAprendizajeBtn) {
        elements.toggleAprendizajeBtn.addEventListener('click', () => {
            const aprendizajeCard = getElement('#aprendizajeCard');
            if (aprendizajeCard) aprendizajeCard.classList.toggle('active');
        });
    }

    if (getElement('#learnBtn')) {
        getElement('#learnBtn').addEventListener('click', () => {
            const pregunta = getElement('#nuevaPregunta')?.value.trim();
            const respuesta = getElement('#nuevaRespuesta')?.value.trim();
            if (!pregunta || !respuesta) {
                mostrarNotificacion('Por favor, completa ambos campos.', 'error');
                return;
            }
            fetch('/aprendizaje', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pregunta, respuesta, usuario: 'anonimo' })
            }).then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                    } else {
                        mostrarNotificacion('Conocimiento aprendido con éxito', 'success');
                        getElement('#nuevaPregunta').value = '';
                        getElement('#nuevaRespuesta').value = '';
                        getElement('#aprendizajeCard')?.classList.remove('active');
                    }
                })
                .catch(error => {
                    mostrarNotificacion(`Error al aprender: ${error.message}`, 'error');
                });
        });
    }

    if (elements.exportTxtBtn) {
        elements.exportTxtBtn.addEventListener('click', exportarTxt);
    }

    if (elements.exportPdfBtn) {
        elements.exportPdfBtn.addEventListener('click', exportarPdf);
    }

    if (getElement('#tema-filter')) {
        getElement('#tema-filter').addEventListener('change', () => {
            const tema = getElement('#tema-filter').value;
            if (tema) {
                getElement('#input').value = tema;
                sendMessage();
            }
        });
    }

    document.querySelectorAll('.left-section button, .nivel-btn').forEach(btn => {
        const tooltipText = btn.dataset.tooltip;
        if (!tooltipText) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = tooltipText;
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'rgba(0, 0, 0, 0.95)';
        tooltip.style.color = '#fff';
        tooltip.style.padding = '8px 12px';
        tooltip.style.borderRadius = '6px';
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
});