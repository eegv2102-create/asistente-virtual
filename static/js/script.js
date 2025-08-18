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

const pauseResumeAI = () => {
    const btn = getElement('#pause-resume-ai');
    if (currentAudio instanceof Audio) {
        if (currentAudio.paused) {
            currentAudio.play();
            btn.innerHTML = '<i class="fas fa-pause"></i>';
            btn.dataset.tooltip = 'Pausar IA';
            mostrarNotificacion('IA reanudada', 'info');
        } else {
            currentAudio.pause();
            btn.innerHTML = '<i class="fas fa-play"></i>';
            btn.dataset.tooltip = 'Reanudar IA';
            mostrarNotificacion('IA pausada', 'info');
        }
    } else if ('speechSynthesis' in window && currentAudio) {
        if (speechSynthesis.paused) {
            speechSynthesis.resume();
            btn.innerHTML = '<i class="fas fa-pause"></i>';
            btn.dataset.tooltip = 'Pausar IA';
            mostrarNotificacion('IA reanudada', 'info');
        } else {
            speechSynthesis.pause();
            btn.innerHTML = '<i class="fas fa-play"></i>';
            btn.dataset.tooltip = 'Reanudar IA';
            mostrarNotificacion('IA pausada', 'info');
        }
    }
};

const toggleVoice = () => {
    vozActiva = !vozActiva;
    const btn = getElement('#toggle-voice');
    btn.innerHTML = `<i class="fas fa-volume-${vozActiva ? 'up' : 'mute'}"></i>`;
    btn.dataset.tooltip = vozActiva ? 'Desactivar Voz' : 'Activar Voz';
    mostrarNotificacion(`Voz ${vozActiva ? 'activada' : 'desactivada'}`, 'info');
};

const startStopVoice = () => {
    const btn = getElement('#voice-control');
    if (!isListening && 'webkitSpeechRecognition' in window) {
        recognition = new webkitSpeechRecognition();
        recognition.lang = 'es-ES';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = event => {
            const transcript = Array.from(event.results)
                .map(result => result[0].transcript)
                .join('');
            getElement('#input').value = transcript;
        };
        recognition.onerror = event => {
            mostrarNotificacion(`Error en reconocimiento de voz: ${event.error}`, 'error');
        };
        recognition.onend = () => {
            isListening = false;
            btn.innerHTML = '<i class="fas fa-microphone"></i>';
            btn.dataset.tooltip = 'Iniciar Voz';
            mostrarNotificacion('Reconocimiento de voz detenido', 'info');
        };
        recognition.start();
        isListening = true;
        btn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
        btn.dataset.tooltip = 'Detener Voz';
        mostrarNotificacion('Reconocimiento de voz iniciado', 'info');
    } else if (isListening && recognition) {
        recognition.stop();
        isListening = false;
        btn.innerHTML = '<i class="fas fa-microphone"></i>';
        btn.dataset.tooltip = 'Iniciar Voz';
        mostrarNotificacion('Reconocimiento de voz detenido', 'info');
    }
};

const exportarTxt = () => {
    const messages = getElements('.message-container .bot, .message-container .user');
    let text = '';
    messages.forEach(msg => {
        const prefix = msg.classList.contains('user') ? 'Usuario: ' : 'Asistente: ';
        text += `${prefix}${msg.textContent}\n`;
    });
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chat.txt';
    a.click();
    URL.revokeObjectURL(url);
    mostrarNotificacion('Chat exportado a TXT', 'success');
};

const exportarPdf = () => {
    const doc = new jsPDF();
    const messages = getElements('.message-container .bot, .message-container .user');
    let y = 10;
    messages.forEach(msg => {
        const prefix = msg.classList.contains('user') ? 'Usuario: ' : 'Asistente: ';
        doc.text(`${prefix}${msg.textContent}`, 10, y);
        y += 10;
        if (y > 280) {
            doc.addPage();
            y = 10;
        }
    });
    doc.save('chat.pdf');
    mostrarNotificacion('Chat exportado a PDF', 'success');
};

const cargarAvatares = async () => {
    const avatarContainer = getElement('.avatar-options');
    if (!avatarContainer) {
        console.error('Elemento .avatar-options no encontrado');
        return;
    }
    try {
        const res = await fetch('/avatares');
        const avatars = await res.json();
        avatarContainer.innerHTML = avatars.map(avatar => `
            <img src="${avatar.url}" alt="${avatar.nombre}" class="avatar-option ${avatar.avatar_id === selectedAvatar ? 'selected' : ''}" data-id="${avatar.avatar_id}">
        `).join('');
        getElements('.avatar-option').forEach(option => {
            option.addEventListener('click', () => {
                selectedAvatar = option.dataset.id;
                localStorage.setItem('selectedAvatar', selectedAvatar);
                getElements('.avatar-option').forEach(opt => opt.classList.remove('selected'));
                option.classList.add('selected');
                mostrarNotificacion('Avatar actualizado', 'success');
            });
        });
    } catch (error) {
        console.error('Error al cargar avatares:', error);
        avatarContainer.innerHTML = `
            <img src="/static/img/default-avatar.png" alt="Avatar Predeterminado" class="avatar-option selected" data-id="default">
            <img src="/static/img/poo.png" alt="POO Avatar" class="avatar-option" data-id="poo">
        `;
    }
};

const buscarTema = async () => {
    const input = getElement('#search-input').value.trim();
    if (!input) return;
    const messageContainer = getElement('.message-container');
    messageContainer.innerHTML += `<div class="user">${input}</div>`;
    scrollToBottom();
    try {
        const res = await fetch('/buscar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pregunta: input, usuario: 'anonimo' })
        });
        const data = await res.json();
        let responseText = data.respuesta || 'No se encontró una respuesta.';
        messageContainer.innerHTML += `<div class="bot">${responseText}</div>`;
        scrollToBottom();
        if (vozActiva) speakText(responseText);
    } catch (error) {
        console.error('Error al buscar:', error);
        messageContainer.innerHTML += `<div class="bot">Error al buscar la respuesta.</div>`;
        scrollToBottom();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        toggleTheme: getElement('#toggle-theme'),
        exportTxtBtn: getElement('#export-txt'),
        exportPdfBtn: getElement('#export-pdf'),
        toggleVoice: getElement('#toggle-voice'),
        voiceControl: getElement('#voice-control'),
        pauseResumeAI: getElement('#pause-resume-ai'),
        sendBtn: getElement('#send-btn'),
        newChat: getElement('#new-chat'),
        clearChat: getElement('#clear-chat'),
        quizBtn: getElement('#quiz-btn'),
        recomendarBtn: getElement('#recomendar-btn'),
        menuToggle: getElement('.menu-toggle'),
        menuToggleRight: getElement('.menu-toggle-right'),
        temaFilter: getElement('#tema-filter'),
        chatList: getElement('#chat-list'),
    };

    if (elements.toggleTheme) {
        elements.toggleTheme.addEventListener('click', () => {
            document.body.classList.toggle('modo-claro');
            elements.toggleTheme.innerHTML = `<i class="fas fa-${document.body.classList.contains('modo-claro') ? 'moon' : 'sun'}"></i>`;
            mostrarNotificacion(`Modo ${document.body.classList.contains('modo-claro') ? 'claro' : 'oscuro'} activado`, 'info');
        });
    }

    if (elements.toggleVoice) {
        elements.toggleVoice.addEventListener('click', toggleVoice);
    }

    if (elements.voiceControl) {
        elements.voiceControl.addEventListener('click', startStopVoice);
    }

    if (elements.pauseResumeAI) {
        elements.pauseResumeAI.addEventListener('click', pauseResumeAI);
    }

    if (elements.sendBtn) {
        elements.sendBtn.addEventListener('click', buscarTema);
        getElement('#input').addEventListener('keypress', e => {
            if (e.key === 'Enter') buscarTema();
        });
    }

    if (elements.newChat) {
        elements.newChat.addEventListener('click', () => {
            getElement('.message-container').innerHTML = '';
            getElement('#input').value = '';
            mostrarNotificacion('Nuevo chat iniciado', 'success');
        });
    }

    if (elements.clearChat) {
        elements.clearChat.addEventListener('click', () => {
            getElement('.message-container').innerHTML = '';
            getElement('#input').value = '';
            mostrarNotificacion('Chat eliminado', 'success');
        });
    }

    if (elements.quizBtn) {
        elements.quizBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/quiz?usuario=anonimo');
                const quiz = await res.json();
                if (quiz.error) {
                    mostrarNotificacion(quiz.error, 'error');
                    return;
                }
                const messageContainer = getElement('.message-container');
                messageContainer.innerHTML += `
                    <div class="bot">${quiz.pregunta}<br>${quiz.opciones.map((opt, i) => `${i + 1}. ${opt}`).join('<br>')}</div>
                `;
                scrollToBottom();
                speakText(quiz.pregunta);
            } catch (error) {
                mostrarNotificacion('Error al cargar el quiz', 'error');
            }
        });
    }

    if (elements.recomendarBtn) {
        elements.recomendarBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/recomendacion?usuario=anonimo');
                const data = await res.json();
                if (data.error) {
                    mostrarNotificacion(data.error, 'error');
                    return;
                }
                const messageContainer = getElement('.message-container');
                messageContainer.innerHTML += `<div class="bot">Tema recomendado: ${data.recomendacion}</div>`;
                scrollToBottom();
                speakText(`Tema recomendado: ${data.recomendacion}`);
            } catch (error) {
                mostrarNotificacion('Error al recomendar tema', 'error');
            }
        });
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

    if (elements.temaFilter) {
        elements.temaFilter.addEventListener('change', () => {
            const tema = elements.temaFilter.value;
            if (tema) {
                getElement('#search-input').value = tema;
                buscarTema();
            }
        });
    }

    document.querySelectorAll('.nivel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const nivel = btn.dataset.nivel;
            document.body.className = nivel;
            mostrarNotificacion(`Nivel ${nivel.charAt(0).toUpperCase() + nivel.slice(1)} seleccionado`, 'info');
        });
    });

    document.querySelectorAll('.left-section button, .nivel-btn, .input-group button').forEach(btn => {
        const tooltipText = btn.dataset.tooltip;
        if (!tooltipText) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'custom-tooltip';
        tooltip.textContent = tooltipText;
        document.body.appendChild(tooltip);

        btn.addEventListener('mouseenter', () => {
            tooltip.style.opacity = '1';
            tooltip.style.visibility = 'visible';
        });

        btn.addEventListener('mouseleave', () => {
            tooltip.style.opacity = '0';
            tooltip.style.visibility = 'hidden';
        });
    });

    cargarAvatares();
});