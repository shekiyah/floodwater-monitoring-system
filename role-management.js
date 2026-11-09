// supabaseClient, escapeHtml and formatMonitor* come from supabase-config.js;
// requireRole and navReady come from nav.js.
//
// SECURITY MODEL
// This page only DISPLAYS and REQUESTS. It never writes to `profiles` itself.
// Everything goes through four Postgres functions (role-management.sql):
//   admin_role_counts, admin_list_users, admin_set_user_role, admin_role_history
// Each one re-checks, inside the database, that the signed-in caller is an
// administrator, validates the role, protects the last administrator and writes
// the audit record. requireRole("admin") below is only a convenience: even if
// someone bypasses it, the functions refuse them.

const PAGE_SIZE = 10;

const ROLE_LABEL = { admin: "Administrator", moderator: "Moderator", viewer: "Viewer" };
const VALID_ROLES = Object.keys(ROLE_LABEL);

const ERROR_TEXT = {
    NOT_AUTHORIZED: "You are not authorized to perform this action.",
    INVALID_ROLE: "Invalid role selection.",
    USER_NOT_FOUND: "User not found. The list has been refreshed.",
    LAST_ADMIN: "This is the last remaining Administrator. Promote another user to Administrator first.",
    ROLE_CHANGED: "This user's role was changed by someone else. The list has been refreshed. Review it and try again.",
    NO_CHANGE: "The user already has that role."
};

const byId = id => document.getElementById(id);

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
const users = { page: 0, total: 0, search: "", role: "", token: 0, byId: new Map() };
const audit = { page: 0, total: 0, token: 0 };

let myUserId = null;
let submitting = false;        // blocks duplicate submissions
let selectedUser = null;       // the row being edited
let lastFocus = null;

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function roleBadge(role) {

    const key = VALID_ROLES.includes(role) ? role : "viewer";

    return `<span class="rm-role rm-role--${key}">${escapeHtml(ROLE_LABEL[key])}</span>`;
}

function describeError(error) {

    const message = String((error && error.message) || "");
    const code = Object.keys(ERROR_TEXT).find(c => message.includes(c));

    if (code) return { code, text: ERROR_TEXT[code] };

    if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
        return { code: "NETWORK", text: "Could not reach the database. Check your connection and try again." };
    }

    return { code: "UNKNOWN", text: "Something went wrong. Nothing was changed." };
}

function toast(text, kind = "ok") {

    const box = byId("rmToasts");
    const node = document.createElement("div");

    node.className = "rm-toast rm-toast--" + kind;
    node.textContent = text;
    box.appendChild(node);

    setTimeout(() => node.remove(), kind === "ok" ? 5000 : 8000);
}

function showDenied(text) {

    byId("rmContent").hidden = true;

    const node = byId("rmDenied");
    node.textContent = text;
    node.hidden = false;
}

function messageBox(id, text) {

    const node = byId(id);

    node.textContent = text || "";
    node.hidden = !text;
}

function pagerText(page, total, shown) {

    if (!total) return "";

    const from = page * PAGE_SIZE + 1;
    const to = page * PAGE_SIZE + shown;

    return `Showing ${from}–${to} of ${total.toLocaleString()}`;
}

function setPager(prefix, page, total) {

    byId(prefix + "Prev").disabled = page <= 0;
    byId(prefix + "Next").disabled = (page + 1) * PAGE_SIZE >= total;
}

// A failed call to an admin function. Authorization failures end the session
// on this page; anything else is shown where the data would have been.
function handleListError(error, bodyId, cols) {

    const info = describeError(error);

    if (info.code === "NOT_AUTHORIZED") {
        showDenied("You do not have permission to view this page. Redirecting to the dashboard…");
        setTimeout(() => window.location.replace("dashboard.html"), 1800);
        return;
    }

    console.error("Role management error:", error);

    byId(bodyId).innerHTML =
        `<tr class="rm-empty"><td colspan="${cols}">${escapeHtml(info.text)}</td></tr>`;
}

// ---------------------------------------------------------------
// SUMMARY CARDS
// ---------------------------------------------------------------
async function loadCounts() {

    const { data, error } = await supabaseClient.rpc("admin_role_counts");

    if (error || !data || !data.length) {
        if (error) handleListError(error, "rmUsersBody", 6);
        return;
    }

    const row = data[0];

    byId("statTotal").textContent = Number(row.total).toLocaleString();
    byId("statAdmins").textContent = Number(row.admins).toLocaleString();
    byId("statModerators").textContent = Number(row.moderators).toLocaleString();
    byId("statViewers").textContent = Number(row.viewers).toLocaleString();
}

// ---------------------------------------------------------------
// USERS TABLE
// ---------------------------------------------------------------
async function loadUsers() {

    const token = ++users.token;

    byId("rmUsersBody").innerHTML =
        `<tr class="rm-empty"><td colspan="6"><span class="rm-spinner" aria-hidden="true"></span> Loading users…</td></tr>`;

    const { data, error } = await supabaseClient.rpc("admin_list_users", {
        p_search: users.search || null,
        p_role: users.role || null,
        p_limit: PAGE_SIZE,
        p_offset: users.page * PAGE_SIZE
    });

    if (token !== users.token) return;   // a newer search superseded this one

    if (error) {
        handleListError(error, "rmUsersBody", 6);
        return;
    }

    users.total = data.length ? Number(data[0].total_count) : 0;

    // The last page can disappear after a filter change or a deletion.
    if (!data.length && users.page > 0) {
        users.page = 0;
        loadUsers();
        return;
    }

    users.byId = new Map(data.map(u => [u.id, u]));

    renderUsers(data);

    byId("rmUsersInfo").textContent = pagerText(users.page, users.total, data.length);
    setPager("rmUsers", users.page, users.total);
}

function renderUsers(data) {

    if (!data.length) {
        byId("rmUsersBody").innerHTML =
            `<tr class="rm-empty"><td colspan="6">${users.search || users.role ? "No users match your search." : "No users available."}</td></tr>`;
        return;
    }

    byId("rmUsersBody").innerHTML = data.map(u => {

        const registered = u.created_at
            ? formatMonitorDate(new Date(u.created_at).getTime())
            : "—";

        return `
        <tr>
            <td class="rm-mono" title="${escapeHtml(u.id)}">${escapeHtml(String(u.id).slice(0, 8))}…</td>
            <td class="rm-strong">${escapeHtml(u.full_name || "—")}</td>
            <td class="rm-ellipsis" title="${escapeHtml(u.email || "")}">${escapeHtml(u.email || "—")}</td>
            <td>${roleBadge(u.role)}</td>
            <td class="rm-nowrap">${escapeHtml(registered)}</td>
            <td class="rm-col-action">
                <button type="button" class="rm-btn rm-btn--sm" data-manage="${escapeHtml(u.id)}">
                    <svg class="rm-svg rm-svg--btn" aria-hidden="true"><use href="#i-shield"/></svg>MANAGE ROLE
                </button>
            </td>
        </tr>`;
    }).join("");
}

// ---------------------------------------------------------------
// HISTORY
// ---------------------------------------------------------------
async function loadHistory() {

    const token = ++audit.token;

    const { data, error } = await supabaseClient.rpc("admin_role_history", {
        p_limit: PAGE_SIZE,
        p_offset: audit.page * PAGE_SIZE
    });

    if (token !== audit.token) return;

    if (error) {
        handleListError(error, "rmHistoryBody", 5);
        return;
    }

    audit.total = data.length ? Number(data[0].total_count) : 0;

    if (!data.length && audit.page > 0) {
        audit.page = 0;
        loadHistory();
        return;
    }

    if (!data.length) {
        byId("rmHistoryBody").innerHTML =
            `<tr class="rm-empty"><td colspan="5">No role changes have been recorded yet.</td></tr>`;
    } else {
        byId("rmHistoryBody").innerHTML = data.map(row => {

            const who = row.admin_name || row.admin_email || String(row.admin_id).slice(0, 8) + "…";
            const target = row.target_name || row.target_email || String(row.target_user_id).slice(0, 8) + "…";

            return `
            <tr>
                <td class="rm-nowrap">${escapeHtml(formatMonitorDateTime(new Date(row.changed_at).getTime(), true))}</td>
                <td class="rm-strong" title="${escapeHtml(row.admin_email || row.admin_id)}">${escapeHtml(who)}</td>
                <td title="${escapeHtml(row.target_email || row.target_user_id)}">${escapeHtml(target)}</td>
                <td>${roleBadge(row.previous_role)}</td>
                <td>${roleBadge(row.new_role)}</td>
            </tr>`;
        }).join("");
    }

    byId("rmHistoryInfo").textContent = pagerText(audit.page, audit.total, data.length);
    setPager("rmHistory", audit.page, audit.total);
}

async function refreshAll() {
    await Promise.all([loadCounts(), loadUsers(), loadHistory()]);
}

// ---------------------------------------------------------------
// MODALS (focus handling, Esc, backdrop)
// ---------------------------------------------------------------
function openOverlay(id) {

    lastFocus = document.activeElement;

    byId(id).hidden = false;
    document.body.classList.add("rm-modal-open");
}

function closeOverlay(id) {

    byId(id).hidden = true;

    if (byId("roleModal").hidden && byId("confirmModal").hidden) {
        document.body.classList.remove("rm-modal-open");
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
}

function focusables(root) {
    return [...root.querySelectorAll("button, select, input, [href]")].filter(n => !n.disabled && !n.hidden && n.offsetParent !== null);
}

document.addEventListener("keydown", event => {

    const confirmOpen = !byId("confirmModal").hidden;
    const roleOpen = !byId("roleModal").hidden;

    if (!confirmOpen && !roleOpen) return;

    if (event.key === "Escape" && !submitting) {
        if (confirmOpen) closeOverlay("confirmModal"); else closeRoleModal();
        return;
    }

    if (event.key === "Tab") {
        const root = (confirmOpen ? byId("confirmModal") : byId("roleModal")).querySelector(".rm-modal");
        const items = focusables(root);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

["roleModal", "confirmModal"].forEach(id => {
    byId(id).addEventListener("mousedown", event => {
        if (event.target.id !== id || submitting) return;
        if (id === "confirmModal") closeOverlay(id); else closeRoleModal();
    });
});

// ---------------------------------------------------------------
// MANAGE ROLE
// ---------------------------------------------------------------
function openRoleModal(id) {

    const user = users.byId.get(id);

    if (!user) {
        toast(ERROR_TEXT.USER_NOT_FOUND, "error");
        return;
    }

    selectedUser = user;

    byId("mUser").textContent = user.full_name || "—";
    byId("mEmail").textContent = user.email || "—";
    byId("mCurrent").innerHTML = roleBadge(user.role);
    byId("mNewRole").value = VALID_ROLES.includes(user.role) ? user.role : "viewer";

    messageBox("mMsg", "");
    updateSaveState();

    openOverlay("roleModal");
    byId("mNewRole").focus();
}

function closeRoleModal() {

    if (submitting) return;

    closeOverlay("confirmModal");
    closeOverlay("roleModal");
    selectedUser = null;
}

function updateSaveState() {

    const unchanged = !selectedUser || byId("mNewRole").value === selectedUser.role;

    byId("roleSave").disabled = submitting || unchanged;
}

byId("mNewRole").addEventListener("change", () => {
    messageBox("mMsg", "");
    updateSaveState();
});

byId("roleCancel").addEventListener("click", closeRoleModal);
byId("roleModalX").addEventListener("click", closeRoleModal);

// SAVE CHANGES -> validate -> confirmation dialog
byId("roleForm").addEventListener("submit", event => {

    event.preventDefault();

    if (submitting || !selectedUser) return;

    const newRole = byId("mNewRole").value;

    if (!VALID_ROLES.includes(newRole)) {
        messageBox("mMsg", ERROR_TEXT.INVALID_ROLE);
        return;
    }

    if (newRole === selectedUser.role) {
        messageBox("mMsg", ERROR_TEXT.NO_CHANGE);
        return;
    }

    const from = ROLE_LABEL[selectedUser.role].toUpperCase();
    const to = ROLE_LABEL[newRole].toUpperCase();

    byId("confirmText").textContent =
        `Are you sure you want to change this user's role from ${from} to ${to}?`;

    const notes = [];

    if (selectedUser.id === myUserId) {
        notes.push("This is your own account.");
    }

    if (selectedUser.role === "admin") {
        notes.push("This user is an Administrator. Their administrator access ends as soon as the change is saved.");
    }

    if (newRole === "admin") {
        notes.push("Administrators can manage every user's role, the recipients, the firmware and the settings.");
    }

    const extra = byId("confirmExtra");
    extra.textContent = notes.join(" ");
    extra.hidden = notes.length === 0;

    messageBox("cMsg", "");
    openOverlay("confirmModal");
    byId("confirmCancel").focus();
});

byId("confirmCancel").addEventListener("click", () => {
    if (!submitting) closeOverlay("confirmModal");
});

// Confirmed: send it. The database makes the real decision.
byId("confirmOk").addEventListener("click", async () => {

    if (submitting || !selectedUser) return;   // duplicate-submission guard

    const target = selectedUser;
    const newRole = byId("mNewRole").value;

    if (!VALID_ROLES.includes(newRole)) {
        messageBox("cMsg", ERROR_TEXT.INVALID_ROLE);
        return;
    }

    submitting = true;
    byId("confirmOk").disabled = true;
    byId("roleSave").disabled = true;
    byId("confirmOk").textContent = "SAVING…";
    messageBox("cMsg", "");

    let outcome = null;

    try {

        const { data, error } = await supabaseClient.rpc("admin_set_user_role", {
            p_target: target.id,
            p_new_role: newRole,
            p_expected_role: target.role
        });

        if (error) {
            outcome = describeError(error);
        } else if (!data || data.ok !== true || data.new_role !== newRole) {
            // Never claim success unless the database says it saved this role.
            outcome = { code: "UNKNOWN", text: "The change could not be confirmed. Nothing was reported as saved. Refresh and check the user's role." };
        }

    } catch (err) {
        console.error("Role change failed:", err);
        outcome = describeError(err);
    } finally {
        submitting = false;
        byId("confirmOk").disabled = false;
        byId("confirmOk").textContent = "YES, CHANGE ROLE";
    }

    if (outcome) {

        if (outcome.code === "NOT_AUTHORIZED") {
            closeRoleModal();
            showDenied("You do not have permission to manage roles. Redirecting to the dashboard…");
            setTimeout(() => window.location.replace("dashboard.html"), 1800);
            return;
        }

        messageBox("cMsg", outcome.text);
        toast(outcome.text, "error");

        // The list may be out of date (role changed, user gone): reload it.
        if (["ROLE_CHANGED", "USER_NOT_FOUND", "NO_CHANGE", "LAST_ADMIN"].includes(outcome.code)) {
            closeOverlay("confirmModal");
            closeRoleModal();
            refreshAll();
        }

        updateSaveState();
        return;
    }

    closeOverlay("confirmModal");
    closeRoleModal();

    toast("USER ROLE UPDATED SUCCESSFULLY", "ok");

    // Refresh the table, the four summary cards and the history from the database.
    await refreshAll();
});

// ---------------------------------------------------------------
// CONTROLS
// ---------------------------------------------------------------
byId("rmUsersBody").addEventListener("click", event => {

    const button = event.target.closest("button[data-manage]");

    if (button) openRoleModal(button.dataset.manage);
});

let searchTimer = null;

byId("rmSearch").addEventListener("input", event => {

    clearTimeout(searchTimer);

    searchTimer = setTimeout(() => {
        users.search = event.target.value.trim();
        users.page = 0;
        loadUsers();
    }, 300);
});

byId("rmRoleFilter").addEventListener("change", event => {

    users.role = event.target.value;
    users.page = 0;
    loadUsers();
});

byId("rmUsersPrev").addEventListener("click", () => { if (users.page > 0) { users.page--; loadUsers(); } });
byId("rmUsersNext").addEventListener("click", () => { if ((users.page + 1) * PAGE_SIZE < users.total) { users.page++; loadUsers(); } });
byId("rmHistoryPrev").addEventListener("click", () => { if (audit.page > 0) { audit.page--; loadHistory(); } });
byId("rmHistoryNext").addEventListener("click", () => { if ((audit.page + 1) * PAGE_SIZE < audit.total) { audit.page++; loadHistory(); } });

// ---------------------------------------------------------------
// START-UP
// ---------------------------------------------------------------
async function init() {

    // Page-level guard (convenience). The database functions are the real check.
    if (!(await requireRole("admin", "Only administrators can open Role Management."))) {
        return;
    }

    const session = await navReady;
    myUserId = session && session.user ? session.user.id : null;

    byId("rmContent").hidden = false;

    refreshAll();
}

init();