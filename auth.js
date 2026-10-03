// supabaseClient comes from supabase-config.js

const loginMessage = document.getElementById("message");
const loginButton = document.getElementById("loginButton");

function showLoginMessage(text, kind) {

    loginMessage.textContent = text;
    loginMessage.className = "form-status" + (kind ? " form-status--" + kind : "");
}

async function login(event) {

    event.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    if (!email || !password) {
        showLoginMessage("Enter your email and password.", "error");
        return;
    }

    loginButton.disabled = true;
    showLoginMessage("Logging in…");

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {

        console.error(error);

        showLoginMessage(
            /invalid login credentials/i.test(error.message)
                ? "That email and password don't match. Check them and try again."
                : error.message,
            "error"
        );

        loginButton.disabled = false;
        return;
    }

    window.location.href = "dashboard.html";
}

// Someone who's already signed in has no reason to see the form.
supabaseClient.auth.getSession().then(({ data }) => {

    if (data && data.session) {
        window.location.replace("dashboard.html");
    }
});