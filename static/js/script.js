document.addEventListener("DOMContentLoaded", () => {
    const elements = {
        chatbox: document.querySelector("#chatbox .message-container"),
        input: document.getElementById("input"),
        sendBtn: document.getElementById("send-btn"),
        clearBtn: document.getElementById("btn-clear"),
        newChatBtn: document.getElementById("new-chat-btn"),
        voiceBtn: document.getElementById("voice-btn"),
        quizBtn: document.getElementById("quiz-btn"),
        recommendBtn: document.getElementById("recommend-btn"),
        startVoiceBtn: document.getElementById("btn-start-voice"),
        stopVoiceBtn: document.getElementById("btn-stop-voice"),
        pauseSpeechBtn: document.getElementById("btn-pause-speech"),
        resumeSpeechBtn: document.getElementById("btn-resume-speech"),
        modoBtn: document.getElementById("modo-btn"),
        chatList: document.getElementById("chat-list"),
        notificationCard: document.getElementById("notification-card"),
        quizModal: document.getElementById("quiz-modal"),
        quizQuestion: document.getElementById("quiz-question"),
        quizOptions: document.getElementById("quiz-options"),
        quizSubmit: document.getElementById("quiz-submit")
    };

    let currentChatId = null;
    let usuario = "anonimo";
    let avatarId = "default";
    let recognition = null;
    let isRecognitionActive = false;
    let speechSynthesis = window.speechSynthesis;
    let utterance = null;

    // Mostrar notificación
    function mostrarNotificacion(mensaje, tipo = "info") {
        elements.notificationCard.textContent = mensaje;
        elements.notificationCard.className = `active ${tipo}`;
        setTimeout(() => {
            elements.notificationCard.className = "";
        }, 3000);
    }

    // Cargar historial de chats
    function cargarHistorial() {
        fetch(`/progreso?usuario=${usuario}`)
            .then(response => response.json())
            .then(data => {
                elements.chatList.innerHTML = "";
                const chats = JSON.parse(localStorage.getItem("chats") || "[]");
                chats.forEach((chat, index) => {
                    const li = document.createElement("li");
                    li.textContent = `Chat ${index + 1}`;
                    li.dataset.chatId = index;
                    li.addEventListener("click", () => {
                        currentChatId = index;
                        cargarChat(index);
                        document.querySelectorAll("#chat-list li").forEach(item => item.classList.remove("selected"));
                        li.classList.add("selected");
                    });
                    elements.chatList.appendChild(li);
                });
            });
    }

    // Cargar mensajes de un chat
    function cargarChat(chatId) {
        const chats = JSON.parse(localStorage.getItem("chats") || "[]");
        elements.chatbox.innerHTML = "";
        if (chats[chatId]) {
            chats[chatId].forEach(msg => {
                addMessage(msg.text, msg.type);
            });
        }
    }

    // Agregar mensaje al chat
    function addMessage(text, type) {
        const messageDiv = document.createElement("div");
        messageDiv.className = type;
        const content = document.createElement("div");
        content.innerHTML = marked.parse(text);
        messageDiv.appendChild(content);
        if (type === "bot") {
            const copyBtn = document.createElement("button");
            copyBtn.className = "copy-btn";
            copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
            copyBtn.addEventListener("click", () => {
                navigator.clipboard.writeText(text).then(() => {
                    mostrarNotificacion("Texto copiado", "success");
                });
            });
            messageDiv.appendChild(copyBtn);
        }
        elements.chatbox.appendChild(messageDiv);
        elements.chatbox.scrollTop = elements.chatbox.scrollHeight;
        Prism.highlightAll();
    }

    // Enviar mensaje
    function enviarMensaje() {
        const pregunta = elements.input.value.trim();
        if (!pregunta) return;
        addMessage(pregunta, "user");
        elements.input.value = "";

        fetch("/respuesta", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pregunta, usuario, avatar_id: avatarId })
        })
            .then(response => response.json())
            .then(data => {
                if (data.error) {
                    mostrarNotificacion(data.error, "error");
                    return;
                }
                addMessage(data.respuesta, "bot");
                const chats = JSON.parse(localStorage.getItem("chats") || "[]");
                if (!chats[currentChatId]) chats[currentChatId] = [];
                chats[currentChatId].push({ text: pregunta, type: "user" });
                chats[currentChatId].push({ text: data.respuesta, type: "bot" });
                localStorage.setItem("chats", JSON.stringify(chats));
                cargarHistorial();
            })
            .catch(error => {
                mostrarNotificacion("Error al obtener respuesta", "error");
            });
    }

    // Iniciar nuevo chat
    if (elements.newChatBtn) {
        elements.newChatBtn.addEventListener("click", () => {
            currentChatId = (JSON.parse(localStorage.getItem("chats") || "[]")).length;
            localStorage.setItem("chats", JSON.stringify([...JSON.parse(localStorage.getItem("chats") || "[]"), []]));
            elements.chatbox.innerHTML = "";
            cargarHistorial();
            mostrarNotificacion("Nuevo chat iniciado", "success");
        });
    }

    // Limpiar chat
    if (elements.clearBtn) {
        elements.clearBtn.addEventListener("click", () => {
            elements.chatbox.innerHTML = "";
            const chats = JSON.parse(localStorage.getItem("chats") || "[]");
            if (chats[currentChatId]) {
                chats[currentChatId] = [];
                localStorage.setItem("chats", JSON.stringify(chats));
            }
            mostrarNotificacion("Chat limpiado", "success");
        });
    }

    // Toggle modo claro/oscuro
    if (elements.modoBtn) {
        elements.modoBtn.addEventListener("click", () => {
            document.body.classList.toggle("modo-oscuro");
            const modo = document.body.classList.contains("modo-oscuro") ? "Oscuro" : "Claro";
            elements.modoBtn.innerHTML = `<i class="fas fa-${modo === 'Claro' ? 'moon' : 'sun'}"></i>`;
            mostrarNotificacion(`Modo ${modo} activado`, "success");
        });
    }

    // Iniciar reconocimiento de voz
    if (elements.startVoiceBtn && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.lang = "es-ES";
        recognition.interimResults = false;

        elements.startVoiceBtn.addEventListener("click", () => {
            recognition.start();
            isRecognitionActive = true;
            elements.startVoiceBtn.disabled = true;
            elements.stopVoiceBtn.disabled = false;
            mostrarNotificacion("Reconocimiento de voz iniciado", "info");
        });

        recognition.onresult = event => {
            const transcript = event.results[0][0].transcript;
            elements.input.value = transcript;
            enviarMensaje();
        };

        recognition.onend = () => {
            isRecognitionActive = false;
            elements.startVoiceBtn.disabled = false;
            elements.stopVoiceBtn.disabled = true;
            mostrarNotificacion("Reconocimiento de voz detenido", "info");
        };
    }

    // Detener reconocimiento de voz
    if (elements.stopVoiceBtn) {
        elements.stopVoiceBtn.addEventListener("click", () => {
            if (isRecognitionActive) {
                recognition.stop();
            }
        });
    }

    // Activar/desactivar voz
    if (elements.voiceBtn) {
        elements.voiceBtn.addEventListener("click", () => {
            speechSynthesis.cancel();
            elements.voiceBtn.classList.toggle("active");
            mostrarNotificacion(elements.voiceBtn.classList.contains("active") ? "Voz activada" : "Voz desactivada", "info");
        });
    }

    // Pausar voz
    if (elements.pauseSpeechBtn) {
        elements.pauseSpeechBtn.addEventListener("click", () => {
            if (speechSynthesis.speaking) {
                speechSynthesis.pause();
                elements.pauseSpeechBtn.disabled = true;
                elements.resumeSpeechBtn.disabled = false;
                mostrarNotificacion("Voz pausada", "info");
            }
        });
    }

    // Reanudar voz
    if (elements.resumeSpeechBtn) {
        elements.resumeSpeechBtn.addEventListener("click", () => {
            if (speechSynthesis.paused) {
                speechSynthesis.resume();
                elements.pauseSpeechBtn.disabled = false;
                elements.resumeSpeechBtn.disabled = true;
                mostrarNotificacion("Voz reanudada", "info");
            }
        });
    }

    // Iniciar quiz
    if (elements.quizBtn) {
        elements.quizBtn.addEventListener("click", () => {
            fetch(`/quiz?usuario=${usuario}`)
                .then(response => response.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, "error");
                        return;
                    }
                    elements.quizQuestion.textContent = data.pregunta;
                    elements.quizOptions.innerHTML = "";
                    data.opciones.forEach(opcion => {
                        const btn = document.createElement("button");
                        btn.className = "quiz-option";
                        btn.textContent = opcion;
                        btn.addEventListener("click", () => {
                            document.querySelectorAll(".quiz-option").forEach(b => b.classList.remove("selected"));
                            btn.classList.add("selected");
                        });
                        elements.quizOptions.appendChild(btn);
                    });
                    elements.quizModal.style.display = "block";
                    elements.quizSubmit.onclick = () => {
                        const selected = document.querySelector(".quiz-option.selected");
                        if (!selected) {
                            mostrarNotificacion("Selecciona una opción", "error");
                            return;
                        }
                        fetch("/responder_quiz", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                respuesta: selected.textContent,
                                respuesta_correcta: data.respuesta_correcta,
                                tema: data.tema,
                                usuario
                            })
                        })
                            .then(response => response.json())
                            .then(result => {
                                mostrarNotificacion(result.respuesta, result.es_correcta ? "success" : "error");
                                elements.quizModal.style.display = "none";
                            });
                    };
                });
        });
    }

    // Recomendar tema
    if (elements.recommendBtn) {
        elements.recommendBtn.addEventListener("click", () => {
            fetch(`/recommend?usuario=${usuario}`)
                .then(response => response.json())
                .then(data => {
                    if (data.error) {
                        mostrarNotificacion(data.error, "error");
                        return;
                    }
                    addMessage(data.recomendacion, "bot");
                    const chats = JSON.parse(localStorage.getItem("chats") || "[]");
                    if (!chats[currentChatId]) chats[currentChatId] = [];
                    chats[currentChatId].push({ text: data.recomendacion, type: "bot" });
                    localStorage.setItem("chats", JSON.stringify(chats));
                    cargarHistorial();
                });
        });
    }

    // Enviar mensaje con botón o Enter
    if (elements.sendBtn) {
        elements.sendBtn.addEventListener("click", enviarMensaje);
    }
    if (elements.input) {
        elements.input.addEventListener("keypress", e => {
            if (e.key === "Enter") enviarMensaje();
        });
    }

    // Cargar avatares
    fetch("/avatars")
        .then(response => response.json())
        .then(avatars => {
            const avatarOptions = document.querySelector(".avatar-options");
            avatars.forEach(avatar => {
                const div = document.createElement("div");
                div.textContent = avatar.nombre;
                div.dataset.avatarId = avatar.avatar_id;
                div.addEventListener("click", () => {
                    avatarId = avatar.avatar_id;
                    document.querySelectorAll(".avatar-options div").forEach(item => item.classList.remove("selected"));
                    div.classList.add("selected");
                    mostrarNotificacion(`Avatar ${avatar.nombre} seleccionado`, "success");
                });
                avatarOptions.appendChild(div);
            });
        });

    // Inicializar historial
    cargarHistorial();
});