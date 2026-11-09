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

// Pages a signed-out visitor is allowed to see. Everything else
// sends them to the login page.
const PUBLIC_PAGES = [
    "",
    "index.html", "index",
    "login.html", "login",
    "register.html", "register"
];

let currentRole = "viewer";

// The role the current page demands (set by requireRole). Used to throw a user
// out when their role is lowered while the page is open.
let requiredRole = null;

// Resolves once, with { user, profile, role } — or null if the visitor
// isn't signed in (in which case they're already being redirected).
// Pages that need to wait for the role call requireRole() below
// instead of fetching the profile again.
const navReady = (async function initNav() {

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

    if (userError || !user) {

        const currentPage = window.location.pathname.split("/").pop();

        if (!PUBLIC_PAGES.includes(currentPage)) {
            window.location.replace("login.html");
        }

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

    ensureAdminMenuLink();
    applyPermissions();

    return { user, profile, role: currentRole };
})();

// Adds "Role Management" to the dropdown for administrators on every page
// that uses this nav, so no other HTML file has to be edited. A page that
// already has the link (role-management.html) is left alone.
function ensureAdminMenuLink() {

    const dropdown = document.getElementById("navDropdown");

    if (!dropdown || dropdown.querySelector('a[href="role-management.html"]')) {
        return;
    }

    const link = document.createElement("a");

    link.href = "role-management.html";
    link.className = "nav-dropdown-item";
    link.setAttribute("role", "menuitem");
    link.dataset.minRole = "admin";
    link.innerHTML = '<span class="icon-chip icon-chip--menu" aria-hidden="true">🛡️</span> Role Management';
    link.addEventListener("click", () => toggleMenu(false));

    const anchor = dropdown.querySelector('a[href="ota.html"]');

    if (anchor) {
        anchor.after(link);
    } else {
        dropdown.insertBefore(link, dropdown.querySelector(".nav-dropdown-divider"));
    }
}

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

    requiredRole = minRole;

    const session = await navReady;

    if (!session) {

        // Signed out on a protected page: go to login.
        const currentPage = window.location.pathname.split("/").pop();

        if (!PUBLIC_PAGES.includes(currentPage)) {
            window.location.replace("login.html");
        }

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

// ROLE REFRESH
// The role is re-read from the database (never from the browser) when the tab
// comes back into view and once a minute while it is open. If an administrator
// lowers this user's role, restricted menu items disappear and a restricted
// page sends them to the dashboard, without logging out or registering again.
// The Row Level Security policies and the admin-only database functions still
// refuse the request on the server whatever this page shows.
let lastRoleCheck = 0;

async function refreshRole() {

    if (Date.now() - lastRoleCheck < 15000) {
        return;
    }

    lastRoleCheck = Date.now();

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();

    if (userError || !user) {
        return;                       // offline or signed out: initNav / the next request handles it
    }

    const { data: profile, error } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();

    if (error) {
        return;
    }

    const fresh = profile && ROLE_RANK[profile.role] !== undefined ? profile.role : "viewer";

    if (fresh === currentRole) {
        return;
    }

    currentRole = fresh;

    const userRoleElement = document.getElementById("userRole");

    if (userRoleElement) {
        userRoleElement.textContent = "Role: " + currentRole;
    }

    applyPermissions();

    if (requiredRole && ROLE_RANK[currentRole] < ROLE_RANK[requiredRole]) {
        window.location.replace("dashboard.html");
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshRole();
});

window.addEventListener("focus", refreshRole);

setInterval(() => {
    if (document.visibilityState === "visible") refreshRole();
}, 60 * 1000);

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