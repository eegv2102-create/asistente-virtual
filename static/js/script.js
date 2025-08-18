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
                getElements('.avatar-option').forEach(el => el.classList.remove('selected'));
                img.classList.add('selected');
                selectedAvatar = avatar.avatar_id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                fetch('/actualizar_avatar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario: 'anonimo', avatar_id: selectedAvatar })
                }).catch(error => console.error('Error actualizando avatar:', error));
            });
        });
    } catch (error) {
        console.error('Error cargando avatares:', error);
    }
};

const sendMessage = () => {
    const input = getElement('#input');
    const message = input.value.trim();
    if (!message) return;
    const messageContainer = getElement('.message-container');
    const userMessage = document.createElement('div');
    userMessage.classList.add('user');
    userMessage.textContent = message;
    messageContainer.appendChild(userMessage);
    input.value = '';
    scrollToBottom();
    fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: message, usuario: 'anonimo' })
    }).then(res => res.json())
        .then(data => {
            const botMessage = document.createElement('div');
            botMessage.classList.add('bot');
            botMessage.innerHTML = data.respuesta || 'Error al procesar la respuesta';
            messageContainer.appendChild(botMessage);
            scrollToBottom();
            if (data.respuesta && !data.respuesta.includes('Error')) {
                speakText(data.respuesta);
            }
            if (data.respuesta.includes('```')) {
                hljs.highlightAll();
            }
        })
        .catch(error => {
            const botMessage = document.createElement('div');
            botMessage.classList.add('bot');
            botMessage.textContent = 'Error al conectar con el servidor';
            messageContainer.appendChild(botMessage);
            scrollToBottom();
        });
};

const cargarHistorial = () => {
    const chatList = getElement('#chat-list');
    if (!chatList) return;
    fetch('/historial?usuario=anonimo')
        .then(res => res.json())
        .then(data => {
            chatList.innerHTML = '';
            data.forEach(chat => {
                const li = document.createElement('li');
                li.textContent = chat.pregunta.slice(0, 50) + (chat.pregunta.length > 50 ? '...' : '');
                li.addEventListener('click', () => {
                    const messageContainer = getElement('.message-container');
                    messageContainer.innerHTML = '';
                    const userMessage = document.createElement('div');
                    userMessage.classList.add('user');
                    userMessage.textContent = chat.pregunta;
                    messageContainer.appendChild(userMessage);
                    const botMessage = document.createElement('div');
                    botMessage.classList.add('bot');
                    botMessage.innerHTML = chat.respuesta;
                    messageContainer.appendChild(botMessage);
                    scrollToBottom();
                    if (chat.respuesta.includes('```')) {
                        hljs.highlightAll();
                    }
                });
                chatList.appendChild(li);
            });
        })
        .catch(error => console.error('Error cargando historial:', error));
};

const exportarTxt = () => {
    const messages = getElements('.message-container > div');
    let text = '';
    messages.forEach(msg => {
        const prefix = msg.classList.contains('user') ? 'Usuario: ' : 'Asistente: ';
        text += `${prefix}${msg.textContent}\n\n`;
    });
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat.txt';
    a.click();
    URL.revokeObjectURL(url);
};

const exportarPdf = () => {
    const doc = new jsPDF();
    let y = 10;
    const messages = getElements('.message-container > div');
    messages.forEach(msg => {
        const prefix = msg.classList.contains('user') ? 'Usuario: ' : 'Asistente: ';
        const text = `${prefix}${msg.textContent}`;
        const splitText = doc.splitTextToSize(text, 180);
        doc.text(splitText, 10, y);
        y += splitText.length * 7;
        if (y > 280) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save('chat.pdf');
};

const buscarTema = () => {
    const searchInput = getElement('#search-input');
    const tema = searchInput?.value.trim();
    if (!tema) return;
    const messageContainer = getElement('.message-container');
    fetch('/buscar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tema, usuario: 'anonimo' })
    }).then(res => res.json())
        .then(data => {
            const botMessage = document.createElement('div');
            botMessage.classList.add('bot');
            botMessage.innerHTML = data.resultados.map(r => `${r.tema}: ${r.contenido} (Score: ${r.score.toFixed(2)})`).join('<br>') || 'No se encontraron resultados';
            messageContainer.appendChild(botMessage);
            scrollToBottom();
            if (data.resultados.length > 0) {
                speakText(data.resultados[0].contenido);
            }
        })
        .catch(error => {
            const botMessage = document.createElement('div');
            botMessage.classList.add('bot');
            botMessage.textContent = 'Error al buscar tema';
            messageContainer.appendChild(botMessage);
            scrollToBottom();
        });
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        input: getElement('#input'),
        btnSend: getElement('#btn-send'),
        btnToggleDark: getElement('#btn-toggle-dark'),
        btnToggleVoice: getElement('#btn-toggle-voice'),
        btnQuiz: getElement('#btn-quiz'),
        btnGenerarTema: getElement('#btn-generar-tema'),
        btnStartVoice: getElement('#btn-start-voice'),
        btnStopVoice: getElement('#btn-stop-voice'),
        btnPauseSpeech: getElement('#btn-pause-speech'),
        btnResumeSpeech: getElement('#btn-resume-speech'),
        btnNuevoChat: getElement('#btn-nuevo-chat'),
        btnEliminarChat: getElement('#btn-eliminar-chat'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        nivelButtons: getElements('.nivel-btn'),
        exportTxtBtn: getElement('#export-txt-btn'),
        exportPdfBtn: getElement('#export-pdf-btn')
    };

    cargarAvatares();
    cargarHistorial();

    if (elements.btnSend) {
        elements.btnSend.addEventListener('click', sendMessage);
    }

    if (elements.input) {
        elements.input.addEventListener('keypress', e => {
            if (e.key === 'Enter') sendMessage();
        });
    }

    if (elements.btnToggleDark) {
        elements.btnToggleDark.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            elements.btnToggleDark.innerHTML = `<i class="fas fa-${document.body.classList.contains('modo-claro') ? 'sun' : 'moon'}"></i>`;
        });
    }

    if (elements.btnToggleVoice) {
        elements.btnToggleVoice.addEventListener('click', () => {
            vozActiva = !vozActiva;
            elements.btnToggleVoice.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
            mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'info');
            if (!vozActiva) stopSpeech();
        });
    }

    if (elements.btnQuiz) {
        elements.btnQuiz.addEventListener('click', () => {
            fetch('/quiz?usuario=anonimo')
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                        return;
                    }
                    const messageContainer = getElement('.message-container');
                    const quizMessage = document.createElement('div');
                    quizMessage.classList.add('bot');
                    quizMessage.innerHTML = `
                        <p>${data.pregunta}</p>
                        <ul>
                            ${data.opciones.map(op => `<li><button onclick="responderQuiz('${op}', '${data.respuesta_correcta}', '${data.tema}')">${op}</button></li>`).join('')}
                        </ul>
                    `;
                    messageContainer.appendChild(quizMessage);
                    scrollToBottom();
                })
                .catch(error => mostrarNotificacion(`Error al cargar quiz: ${error.message}`, 'error'));
        });
    }

    window.responderQuiz = (respuesta, respuesta_correcta, tema) => {
        fetch('/responder_quiz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ respuesta, respuesta_correcta, tema, usuario: 'anonimo' })
        }).then(res => res.json())
            .then(data => {
                const messageContainer = getElement('.message-container');
                const botMessage = document.createElement('div');
                botMessage.classList.add('bot');
                botMessage.textContent = data.respuesta;
                messageContainer.appendChild(botMessage);
                scrollToBottom();
                if (data.es_correcta) {
                    speakText(data.respuesta);
                }
            })
            .catch(error => mostrarNotificacion(`Error al responder quiz: ${error.message}`, 'error'));
    };

    if (elements.btnGenerarTema) {
        elements.btnGenerarTema.addEventListener('click', () => {
            fetch('/recomendacion?usuario=anonimo')
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, 'error');
                        return;
                    }
                    const messageContainer = getElement('.message-container');
                    const botMessage = document.createElement('div');
                    botMessage.classList.add('bot');
                    botMessage.textContent = `Tema recomendado: ${data.recomendacion}`;
                    messageContainer.appendChild(botMessage);
                    scrollToBottom();
                    speakText(`Tema recomendado: ${data.recomendacion}`);
                })
                .catch(error => mostrarNotificacion(`Error al generar tema: ${error.message}`, 'error'));
        });
    }

    if (elements.btnNuevoChat) {
        elements.btnNuevoChat.addEventListener('click', () => {
            const messageContainer = getElement('.message-container');
            messageContainer.innerHTML = '';
            mostrarNotificacion('Nuevo chat iniciado', 'info');
            scrollToBottom();
        });
    }

    if (elements.btnEliminarChat) {
        elements.btnEliminarChat.addEventListener('click', () => {
            const messageContainer = getElement('.message-container');
            if (messageContainer.children.length === 0) {
                mostrarNotificacion('No hay mensajes para eliminar', 'info');
                return;
            }
            messageContainer.innerHTML = '';
            mostrarNotificacion('Chat eliminado', 'info');
            scrollToBottom();
        });
    }

    if (elements.nivelButtons) {
        elements.nivelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const nivel = btn.classList.contains('basico') ? 'basico' :
                              btn.classList.contains('intermedio') ? 'intermedio' : 'avanzado';
                fetch('/actualizar_nivel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario: 'anonimo', nivel })
                }).then(res => res.json())
                    .then(data => {
                        if (data.error) {
                            mostrarNotificacion(data.error, 'error');
                            return;
                        }
                        document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-claro') ? 'modo-claro' : ''}`;
                        mostrarNotificacion(data.mensaje, 'success');
                    })
                    .catch(error => mostrarNotificacion(`Error al cambiar nivel: ${error.message}`, 'error'));
            });
        });
    }

    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.lang = 'es-ES';
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        elements.btnStartVoice.addEventListener('click', () => {
            if (!vozActiva) {
                mostrarNotificacion('La voz está desactivada. Actívala primero.', 'error');
                return;
            }
            try {
                recognition.start();
                isListening = true;
                elements.btnStartVoice.disabled = true;
                elements.btnStopVoice.disabled = false;
                mostrarNotificacion('Reconocimiento de voz iniciado', 'info');
            } catch (error) {
                mostrarNotificacion(`Error al iniciar reconocimiento de voz: ${error.message}`, 'error');
            }
        });

        recognition.onresult = event => {
            const transcript = Array.from(event.results)
                .map(result => result[0].transcript)
                .join('');
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

    if (elements.exportTxtBtn) {
        elements.exportTxtBtn.addEventListener('click', exportarTxt);
    }

    if (elements.exportPdfBtn) {
        elements.exportPdfBtn.addEventListener('click', exportarPdf);
    }

    document.querySelectorAll('.left-section button, .nivel-btn, .input-group button').forEach(btn => {
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
            tooltip.style.top = `${rect.top - tooltip.offsetHeight - 5}px`;
            tooltip.style.left = `${rect.left + rect.width / 2 - tooltip.offsetWidth / 2}px`;
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });

        btn.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });
    });
});