// supabaseClient and escapeHtml come from supabase-config.js;
// requireRole comes from nav.js.

// Admin + moderator only. nav.js hides the link for viewers, but that
// doesn't stop a viewer who knows the URL, so the page checks too.
// The RLS policies on `recipients` (and `sms_queue` / `email_queue`,
// used by notifyNewRecipient) are the real security boundary.

const recipientBody = document.getElementById("recipientBody");
const recipientForm = document.getElementById("recipientForm");
const submitButton = document.getElementById("submitButton");
const cancelEditButton = document.getElementById("cancelEditButton");

// When set, the form is in "edit" mode instead of "add" mode.
let editingRecipientId = null;

// Rows by id, so the buttons only need to carry the id.
let recipientsById = new Map();

function showRecipientsMessage(text) {

    recipientBody.innerHTML =
        `<tr class="table-empty"><td colspan="5">${escapeHtml(text)}</td></tr>`;
}

async function loadRecipients() {

    const { data, error } = await supabaseClient
        .from("recipients")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Load recipients error:", error);
        showRecipientsMessage("Could not load recipients. Refresh the page to try again.");
        return;
    }

    recipientsById = new Map(data.map(recipient => [String(recipient.id), recipient]));

    renderRecipientTable(data);
}

function renderRecipientTable(data) {

    if (data.length === 0) {
        showRecipientsMessage("No recipients yet. Add the first person above to start sending alerts.");
        return;
    }

    recipientBody.innerHTML = data.map(recipient => `
        <tr>
            <td class="td-text">${escapeHtml(recipient.name || "-")}</td>
            <td>${escapeHtml(recipient.mobile_number || "-")}</td>
            <td>${escapeHtml(recipient.email || "-")}</td>
            <td>
                <span class="pill ${recipient.active ? "pill--on" : "pill--off"}">
                    ${recipient.active ? "Active" : "Inactive"}
                </span>
            </td>
            <td>
                <div class="row-actions">
                    <button type="button" class="btn btn--secondary btn--sm"
                            data-action="edit" data-id="${escapeHtml(recipient.id)}">Edit</button>
                    <button type="button" class="btn btn--secondary btn--sm"
                            data-action="toggle" data-id="${escapeHtml(recipient.id)}">
                        ${recipient.active ? "Deactivate" : "Activate"}
                    </button>
                    <button type="button" class="btn btn--ghost-danger btn--sm"
                            data-action="delete" data-id="${escapeHtml(recipient.id)}">Delete</button>
                </div>
            </td>
        </tr>
    `).join("");
}

recipientBody.addEventListener("click", event => {

    const button = event.target.closest("button[data-action]");

    if (!button) {
        return;
    }

    const id = button.dataset.id;

    if (button.dataset.action === "edit") {
        startEditRecipient(id);
    } else if (button.dataset.action === "toggle") {
        toggleActive(id);
    } else if (button.dataset.action === "delete") {
        deleteRecipient(id);
    }
});

async function addRecipient(event) {

    event.preventDefault();

    const nameInput = document.getElementById("recipientName");
    const mobileInput = document.getElementById("mobileNumber");
    const emailInput = document.getElementById("email");

    const name = nameInput.value.trim();
    const mobile = mobileInput.value.trim();
    const email = emailInput.value.trim();

    if (!name || !mobile) {
        alert("Enter at least a name and a mobile number.");
        return;
    }

    submitButton.disabled = true;

    try {

        // Edit mode: update the existing row instead of inserting.
        if (editingRecipientId) {

            const { error } = await supabaseClient
                .from("recipients")
                .update({
                    name: name,
                    mobile_number: mobile,
                    email: email || null
                })
                .eq("id", editingRecipientId);

            if (error) {
                alert("Could not save changes: " + error.message);
                return;
            }

            cancelEditRecipient();
            loadRecipients();
            return;
        }

        const { data, error } = await supabaseClient
            .from("recipients")
            .insert({
                name: name,
                mobile_number: mobile,
                email: email || null,
                active: true
            })
            .select()
            .single();

        if (error) {
            alert("Could not add the recipient: " + error.message);
            return;
        }

        recipientForm.reset();

        await notifyNewRecipient(data);
        loadRecipients();

    } finally {
        submitButton.disabled = false;
    }
}

function startEditRecipient(id) {

    const recipient = recipientsById.get(String(id));

    if (!recipient) {
        return;
    }

    editingRecipientId = recipient.id;

    document.getElementById("recipientName").value = recipient.name || "";
    document.getElementById("mobileNumber").value = recipient.mobile_number || "";
    document.getElementById("email").value = recipient.email || "";

    submitButton.textContent = "Save changes";
    cancelEditButton.hidden = false;

    document.getElementById("recipientName").focus();
    recipientForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cancelEditRecipient() {

    editingRecipientId = null;

    recipientForm.reset();

    submitButton.textContent = "Add recipient";
    cancelEditButton.hidden = true;
}

async function notifyNewRecipient(recipient) {

    // Queue a welcome SMS (sent by the GSM module reading sms_queue)
    // and a welcome email (sent by a backend worker reading
    // email_queue). Neither blocks the recipient being added, but
    // failures are shown, since a silent failure here means nobody
    // would know the welcome message never went out.
    const failures = [];

    if (recipient.mobile_number) {

        const { error: smsError } = await supabaseClient
            .from("sms_queue")
            .insert({
                phone: recipient.mobile_number,
                message: `Hi ${recipient.name}, you've been added as a recipient for Flood Monitoring System alerts.`,
                status: "PENDING"
            });

        if (smsError) {
            console.error("SMS queue error:", smsError);
            failures.push(`SMS: ${smsError.message}`);
        }
    }

    if (recipient.email) {

        const { error: emailError } = await supabaseClient
            .from("email_queue")
            .insert({
                recipient_email: recipient.email,
                subject: "Added as Flood Alert Recipient",
                message: `Hi ${recipient.name}, you've been added as a recipient for Flood Monitoring System alerts. You will be notified when water levels reach ALERT, CRITICAL, or DANGER.`,
                status: "PENDING"
            });

        if (emailError) {
            console.error("Email queue error:", emailError);
            failures.push(`Email: ${emailError.message}`);
        }
    }

    if (failures.length > 0) {
        alert(
            "The recipient was added, but the welcome message could not be queued:\n\n" +
            failures.join("\n") +
            "\n\nThey will still get future flood alerts. Check the database " +
            "permissions for sms_queue and email_queue."
        );
    }
}

async function toggleActive(id) {

    const recipient = recipientsById.get(String(id));

    if (!recipient) {
        return;
    }

    const { error } = await supabaseClient
        .from("recipients")
        .update({ active: !recipient.active })
        .eq("id", recipient.id);

    if (error) {
        alert(error.message);
        return;
    }

    loadRecipients();
}

async function deleteRecipient(id) {

    const recipient = recipientsById.get(String(id));

    if (!recipient) {
        return;
    }

    if (!confirm("Remove this recipient? They will stop receiving alerts.")) {
        return;
    }

    const { error } = await supabaseClient
        .from("recipients")
        .delete()
        .eq("id", recipient.id);

    if (error) {
        alert(error.message);
        return;
    }

    if (editingRecipientId === recipient.id) {
        cancelEditRecipient();
    }

    loadRecipients();
}

async function init() {

    if (await requireRole("moderator")) {
        loadRecipients();
    }
}

init();