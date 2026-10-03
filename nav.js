// Shared by every authenticated page (dashboard, history, recipients,
// message-settings, ota, telemetry). Handles the top nav: who is
// logged in, what their role may see, the dropdown, and logout.
//
// Role-gated markup uses data-min-role="moderator" or "admin". Those
// elements stay hidden (see style.css) until the role is confirmed.
// Like every client-side check in this app, this is a convenience;
// the Row Level Security policies in Supabase are the real boundary.
//
// Expects on the page: #userName, #userRole, #menuButton, #navDropdown

const ROLE_RANK = { viewer: 0, moderator: 1, admin: 2 };

let currentRole = "viewer";

// Resolves once, with { user, profile, role } — or null if the visitor
// isn't signed in (in which case they're already being redirected).
// Pages that need to wait for the role call requireRole() below
// instead of fetching the profile again.
const navReady = (async function initNav() {

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

    if (userError || !user) {
        window.location.replace("login.html");
        return null;
    }

    const { data: profile, error: profileError } = await supabaseClient
        .from("profiles")
        .select("full_name, email, role")
        .eq("id", user.id)
        .maybeSingle();

    if (profileError) {
        console.error("Profile error:", profileError);
    }

    currentRole = profile && ROLE_RANK[profile.role] !== undefined
        ? profile.role
        : "viewer";

    const userNameElement = document.getElementById("userName");
    const userRoleElement = document.getElementById("userRole");

    if (userNameElement) {
        userNameElement.textContent = "👤 " + (profile?.full_name || user.email);
    }

    if (userRoleElement) {
        userRoleElement.textContent = "Role: " + currentRole;
    }

    applyPermissions();

    return { user, profile, role: currentRole };
})();

function applyPermissions() {

    document.querySelectorAll("[data-min-role]").forEach(element => {

        const needed = ROLE_RANK[element.dataset.minRole];
        const allowed = needed !== undefined && ROLE_RANK[currentRole] >= needed;

        element.classList.toggle("role-ok", allowed);
    });
}

// Page-level guard. Sends signed-out visitors to the login page and
// anyone below `minRole` back to the dashboard. Returns true if the
// page may continue loading.
async function requireRole(minRole, deniedMessage) {

    const session = await navReady;

    if (!session) {
        return false;
    }

    if (ROLE_RANK[session.role] >= ROLE_RANK[minRole]) {
        return true;
    }

    if (deniedMessage) {
        alert(deniedMessage);
    }

    window.location.replace("dashboard.html");
    return false;
}

// NAV DROPDOWN MENU

function toggleMenu(forceState) {

    const dropdown = document.getElementById("navDropdown");
    const button = document.getElementById("menuButton");

    if (!dropdown || !button) {
        return;
    }

    const shouldOpen =
        typeof forceState === "boolean"
            ? forceState
            : !dropdown.classList.contains("open");

    dropdown.classList.toggle("open", shouldOpen);
    button.setAttribute("aria-expanded", String(shouldOpen));
}

document.addEventListener("click", event => {

    const menu = document.querySelector(".nav-menu");

    if (menu && !menu.contains(event.target)) {
        toggleMenu(false);
    }
});

document.addEventListener("keydown", event => {

    if (event.key !== "Escape") {
        return;
    }

    const dropdown = document.getElementById("navDropdown");

    if (dropdown && dropdown.classList.contains("open")) {
        toggleMenu(false);
        document.getElementById("menuButton")?.focus();
    }
});

document.querySelectorAll(".nav-dropdown-item").forEach(item => {
    item.addEventListener("click", () => toggleMenu(false));
});

async function logout() {

    const { error } = await supabaseClient.auth.signOut();

    if (error) {
        console.error(error);
        alert("Could not log out: " + error.message);
        return;
    }

    window.location.href = "index.html";
}