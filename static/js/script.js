let vozActiva = true, isListening = false, recognition = null, voicesLoaded = false;
let selectedAvatar = localStorage.getItem('selectedAvatar') || 'default';
let currentAudio = null;
const jsPDF = window.jspdf?.jsPDF || null;

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
    });
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
        if (!res.ok) throw new Error(`Error en TTS: ${res.status} ${res.statusText}`);
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
        console.error('TTS /tts falló, intentando speechSynthesis', error);
        mostrarNotificacion('Error en TTS, intentando fallback', 'error');
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
        }
    }
    const botMessage = getElement('.bot:last-child');
    if (botMessage) botMessage.classList.remove('speaking');
};

const toggleVoiceRecognition = () => {
    const voiceToggleBtn = getElement('#voice-toggle-btn');
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
        if (voiceToggleBtn) {
            voiceToggleBtn.classList.add('voice-active');
            voiceToggleBtn.innerHTML = `<i class="fas fa-microphone-slash"></i>`;
            voiceToggleBtn.setAttribute('data-tooltip', 'Detener reconocimiento de voz');
            voiceToggleBtn.setAttribute('aria-label', 'Detener reconocimiento de voz');
        }
        mostrarNotificacion('Reconocimiento de voz iniciado', 'success');
        recognition.onresult = event => {
            const transcript = Array.from(event.results).map(result => result[0].transcript).join('');
            const input = getElement('#input');
            if (input) input.value = transcript;
            if (event.results[event.results.length - 1].isFinal) {
                sendMessage();
                recognition.stop();
                isListening = false;
                if (voiceToggleBtn) {
                    voiceToggleBtn.classList.remove('voice-active');
                    voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                    voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                    voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
                }
            }
        };
        recognition.onerror = event => {
            mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
            console.error('Error en reconocimiento de voz:', event.error);
            recognition.stop();
            isListening = false;
            if (voiceToggleBtn) {
                voiceToggleBtn.classList.remove('voice-active');
                voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
            }
        };
        recognition.onend = () => {
            if (isListening) {
                recognition.start();
            } else {
                if (voiceToggleBtn) {
                    voiceToggleBtn.classList.remove('voice-active');
                    voiceToggleBtn.innerHTML = `<i class="fas fa-microphone"></i>`;
                    voiceToggleBtn.setAttribute('data-tooltip', 'Iniciar reconocimiento de voz');
                    voiceToggleBtn.setAttribute('aria-label', 'Iniciar reconocimiento de voz');
                }
            }
        };
    } else {
        stopSpeech();
    }
};

// ... (resto de las funciones como cargarAvatares, guardarMensaje, etc., permanecen sin cambios)

document.addEventListener('DOMContentLoaded', () => {
    // Desbloquear AudioContext en el primer clic
    document.addEventListener('click', () => {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log('AudioContext desbloqueado');
            });
        }
    }, { once: true });

    if (typeof marked === 'undefined') {
        console.warn('Librería marked no está definida, usando texto plano');
        mostrarNotificacion('Advertencia: No se pudo cargar la librería marked. Las respuestas se mostrarán en texto plano.', 'info');
    }

    const elements = {
        input: getElement('#input'),
        sendBtn: getElement('#send-btn'),
        voiceBtn: getElement('#voice-btn'),
        voiceToggleBtn: getElement('#voice-toggle-btn'),
        chatbox: getElement('#chatbox'),
        toggleAprendizajeBtn: getElement('#toggle-aprendizaje'),
        modoBtn: getElement('#modo-btn'),
        exportTxtBtn: getElement('#exportTxtBtn'),
        exportPdfBtn: getElement('#exportPdfBtn'),
        clearBtn: getElement('#btn-clear'),
        newChatBtn: getElement('#new-chat-btn'),
        recommendBtn: getElement('#recommend-btn'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        searchBtn: getElement('#search-btn'),
        searchInput: getElement('#search-input'),
        tabButtons: getElements('.tab-btn'),
        quizBtn: getElement('#quiz-btn'),
        nivelBtns: getElements('.nivel-btn')
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
    }

    if (elements.clearBtn) {
        elements.clearBtn.addEventListener('click', limpiarChat);
    }

    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener('click', nuevaConversacion);
    }

    if (elements.recommendBtn) {
        elements.recommendBtn.addEventListener('click', () => {
            fetch('/recommend?usuario=anonimo', { cache: 'no-store' })
                .then(res => {
                    if (!res.ok) throw new Error(`Error en /recommend: ${res.status} ${res.statusText}`);
                    return res.json();
                })
                .then(data => {
                    const chatbox = elements.chatbox;
                    const container = chatbox?.querySelector('.message-container');
                    if (!container || !chatbox) return;
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    const recomendacion = `Te recomiendo estudiar: ${data.recomendacion}`;
                    botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(recomendacion) : recomendacion) + `<button class="copy-btn" data-text="${recomendacion}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                    container.appendChild(botDiv);
                    scrollToBottom();
                    if (window.Prism) Prism.highlightAllUnder(botDiv);
                    speakText(recomendacion);
                    guardarMensaje('Recomendación', recomendacion);
                    addCopyButtonListeners();
                }).catch(error => {
                    mostrarNotificacion(`Error al recomendar tema: ${error.message}`, 'error');
                    console.error('Error en fetch /recommend:', error);
                });
        });
    }

    if (elements.searchBtn && elements.searchInput) {
        elements.searchBtn.addEventListener('click', buscarTema);
        elements.searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') buscarTema();
        });
    }

    if (elements.quizBtn && elements.chatbox) {
        elements.quizBtn.addEventListener('click', () => {
            fetch('/quiz?usuario=anonimo', { cache: 'no-store' })
                .then(res => {
                    if (!res.ok) throw new Error(`Error en /quiz: ${res.status} ${res.statusText}`);
                    return res.json();
                })
                .then(data => {
                    const chatbox = elements.chatbox;
                    const container = chatbox?.querySelector('.message-container');
                    if (!container || !chatbox) return;
                    let opcionesHtml = '<div class="quiz-options">';
                    data.opciones.forEach((opcion, i) => {
                        opcionesHtml += `<button class="quiz-option" data-opcion="${opcion}" data-respuesta-correcta="${data.respuesta_correcta}" data-tema="${data.tema}">${i + 1}. ${opcion}</button>`;
                    });
                    opcionesHtml += '</div>';
                    const pregunta = `${data.pregunta}<br>Opciones:<br>${opcionesHtml}`;
                    const botDiv = document.createElement('div');
                    botDiv.classList.add('bot');
                    botDiv.innerHTML = (typeof marked !== 'undefined' ? marked.parse(pregunta) : pregunta) + `<button class="copy-btn" data-text="${data.pregunta}" aria-label="Copiar mensaje"><i class="fas fa-copy"></i></button>`;
                    container.appendChild(botDiv);
                    scrollToBottom();
                    guardarMensaje('Quiz', `${data.pregunta}\nOpciones: ${data.opciones.join(', ')}`);
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
                }).catch(error => {
                    mostrarNotificacion(`Error al generar quiz: ${error.message}`, 'error');
                    console.error('Error en fetch /quiz:', error);
                });
        });
    }

    if (elements.tabButtons) {
        elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                elements.tabButtons.forEach(b => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                getElements('.tab-content > div').forEach(div => div.classList.remove('active'));
                getElement(`.${btn.dataset.tab}`).classList.add('active');
            });
        });
    }

    if (elements.nivelBtns) {
        elements.nivelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const nivel = btn.dataset.nivel;
                document.body.className = `nivel-${nivel} ${document.body.classList.contains('modo-oscuro') ? 'modo-oscuro' : ''}`;
                elements.nivelBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mostrarNotificacion(`Nivel cambiado a ${nivel}`, 'success');
            });
        });
    }

    if (elements.modoBtn) {
        elements.modoBtn.addEventListener('click', () => {
            document.body.classList.toggle('modo-oscuro');
            const modo = document.body.classList.contains('modo-oscuro') ? 'Oscuro' : 'Claro';
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            localStorage.setItem('theme', modo.toLowerCase());
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

    if (elements.voiceToggleBtn) {
        elements.voiceToggleBtn.addEventListener('click', toggleVoiceRecognition);
    }

    if (elements.menuToggle && elements.menuToggleRight) {
        const toggleLeftMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const leftSection = getElement('.left-section');
            const rightSection = getElement('.right-section');
            if (leftSection) {
                leftSection.classList.toggle('active');
                elements.menuToggle.innerHTML = `<i class="fas fa-${leftSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
                if (rightSection && rightSection.classList.contains('active')) {
                    rightSection.classList.remove('active');
                    elements.menuToggleRight.innerHTML = `<i class="fas fa-bars"></i>`;
                }
            }
        };

        const toggleRightMenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rightSection = getElement('.right-section');
            const leftSection = getElement('.left-section');
            if (rightSection) {
                rightSection.classList.toggle('active');
                elements.menuToggleRight.innerHTML = `<i class="fas fa-${rightSection.classList.contains('active') ? 'times' : 'bars'}"></i>`;
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
                    elements.menuToggle.innerHTML = `<i class="fas fa-bars"></i>`;
                }
                if (rightSection && rightSection.classList.contains('active') &&
                    !rightSection.contains(e.target) &&
                    !menuToggleRight.contains(e.target)) {
                    rightSection.classList.remove('active');
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
            fetch('/aprender', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pregunta, respuesta, usuario: 'anonimo' })
            }).then(res => {
                if (!res.ok) throw new Error(`Error en /aprender: ${res.status} ${res.statusText}`);
                return res.json();
            }).then(data => {
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                    console.error('Error en /aprender:', data.error);
                } else {
                    mostrarNotificacion('Conocimiento aprendido con éxito', 'success');
                    getElement('#nuevaPregunta').value = '';
                    getElement('#nuevaRespuesta').value = '';
                    getElement('#aprendizajeCard')?.classList.remove('active');
                }
            }).catch(error => {
                mostrarNotificacion(`Error al aprender: ${error.message}`, 'error');
                console.error('Error en fetch /aprender:', error);
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
                buscarTema();
            }
        });
    }

    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'oscuro') {
        document.body.classList.add('modo-oscuro');
        elements.modoBtn.innerHTML = `<i class="fas fa-sun"></i>`;
    } else {
        document.body.classList.remove('modo-oscuro');
        elements.modoBtn.innerHTML = `<i class="fas fa-moon"></i>`;
    }

    document.querySelectorAll('.left-section button, .nivel-btn, .chat-actions button, .input-buttons button').forEach(btn => {
        const tooltipText = btn.dataset.tooltip;
        if (!tooltipText) return;
        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = tooltipText;
        tooltip.style.position = 'absolute';
        tooltip.style.background = 'var(--bg-secondary)';
        tooltip.style.color = 'var(--text-primary)';
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
});