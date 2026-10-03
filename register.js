// supabaseClient comes from supabase-config.js

const registerMessage = document.getElementById("message");
const registerButton = document.getElementById("registerButton");

function showRegisterMessage(text, kind) {

    registerMessage.textContent = text;
    registerMessage.className = "form-status" + (kind ? " form-status--" + kind : "");
}

async function register(event) {

    event.preventDefault();

    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    if (!name || !email || !password) {
        showRegisterMessage("Fill in every field.", "error");
        return;
    }

    if (password.length < 6) {
        showRegisterMessage("Use a password with at least 6 characters.", "error");
        return;
    }

    registerButton.disabled = true;
    showRegisterMessage("Creating your account…");

    const { data, error } = await supabaseClient.auth.signUp({
        email: email,
        password: password,
        options: {
            data: {
                full_name: name
            }
        }
    });

    if (error) {

        console.error("Registration error:", error);

        showRegisterMessage(error.message, "error");
        registerButton.disabled = false;
        return;
    }

    // When email confirmation is on, Supabase answers a sign-up for an
    // address that already exists with a user that has no identities.
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {

        showRegisterMessage("An account with this email already exists. Log in instead.", "error");
        registerButton.disabled = false;
        return;
    }

    showRegisterMessage(
        data && data.session
            ? "Account created. Opening your dashboard…"
            : "Account created. If you don't get a confirmation email, you can log in now.",
        "ok"
    );

    if (data && data.session) {
        window.location.href = "dashboard.html";
    }
}