// Recipient Management
// Uses the existing Supabase `recipients` table.
// The email column may remain in the database for compatibility, but this
// page no longer asks for, displays, or sends email addresses.

const recipientForm = document.getElementById("recipientForm");
const recipientBody = document.getElementById("recipientBody");
const recipientCount = document.getElementById("recipientCount");
const recipientFormMessage = document.getElementById("recipientFormMessage");
const recipientPageMessage = document.getElementById("recipientPageMessage");
const submitButton = document.getElementById("submitButton");

const RECIPIENT_PAGE_SIZE = 500;

let recipients = [];
let recipientsById = new Map();

function setFormMessage(message, type = "") {
    recipientFormMessage.textContent = message;
    recipientFormMessage.className = `form-status${type ? ` form-status--${type}` : ""}`;
}

function setPageMessage(message, type = "") {
    recipientPageMessage.textContent = message;
    recipientPageMessage.className =
        `form-status recipient-page-message${type ? ` form-status--${type}` : ""}`;
}

function showRecipientsMessage(message) {
    recipientBody.innerHTML = `
        <tr class="table-empty">
            <td colspan="4">${escapeHtml(message)}</td>
        </tr>
    `;
}

// Fetch in pages so the page is not limited to the first default Supabase
// response window. Supabase Row Level Security still controls which records
// the signed-in administrator/moderator is allowed to see.
async function fetchAllRecipients() {
    const allRecipients = [];

    for (let offset = 0; ; offset += RECIPIENT_PAGE_SIZE) {
        const { data, error } = await supabaseClient
            .from("recipients")
            .select("id, name, mobile_number, active, created_at")
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .range(offset, offset + RECIPIENT_PAGE_SIZE - 1);

        if (error) {
            throw error;
        }

        const page = data || [];
        allRecipients.push(...page);

        if (page.length < RECIPIENT_PAGE_SIZE) {
            break;
        }
    }

    return allRecipients;
}

async function loadRecipients() {
    recipientCount.textContent = "Loading recipients...";
    showRecipientsMessage("Loading registered recipients...");

    try {
        recipients = await fetchAllRecipients();
        recipientsById = new Map(
            recipients.map(recipient => [String(recipient.id), recipient])
        );

        renderRecipientTable();
    } catch (error) {
        console.error("Load recipients error:", error);
        recipientCount.textContent = "Unable to load recipients";
        showRecipientsMessage("Could not load recipients. Check your connection or database permissions.");
        setPageMessage(`Could not load recipients: ${error.message}`, "error");
    }
}

function renderRecipientTable() {
    recipientCount.textContent =
        `${recipients.length} registered recipient${recipients.length === 1 ? "" : "s"}`;

    if (recipients.length === 0) {
        showRecipientsMessage("No recipients have been registered yet.");
        return;
    }

    recipientBody.innerHTML = recipients.map(recipient => {
        const isActive = recipient.active === true;
        const safeId = escapeHtml(recipient.id);

        return `
            <tr>
                <td class="td-text">${escapeHtml(recipient.name || "-")}</td>
                <td>${escapeHtml(recipient.mobile_number || "-")}</td>
                <td>
                    <span class="pill ${isActive ? "pill--on" : "pill--off"}">
                        ${isActive ? "Active" : "Inactive"}
                    </span>
                </td>
                <td>
                    <div class="row-actions recipient-actions">
                        <button
                            type="button"
                            class="btn btn--secondary btn--sm recipient-state-button"
                            data-action="set-active"
                            data-id="${safeId}"
                            ${isActive ? "disabled aria-pressed=\"true\"" : "aria-pressed=\"false\""}
                        >Active</button>

                        <button
                            type="button"
                            class="btn btn--secondary btn--sm recipient-state-button"
                            data-action="set-inactive"
                            data-id="${safeId}"
                            ${!isActive ? "disabled aria-pressed=\"true\"" : "aria-pressed=\"false\""}
                        >Inactive</button>

                        <button
                            type="button"
                            class="btn btn--ghost-danger btn--sm"
                            data-action="delete"
                            data-id="${safeId}"
                        >Delete</button>
                    </div>
                </td>
            </tr>
        `;
    }).join("");
}

recipientForm.addEventListener("submit", addRecipient);

recipientBody.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");

    if (!button || button.disabled) {
        return;
    }

    const { action, id } = button.dataset;

    if (action === "set-active") {
        await updateRecipientStatus(id, true);
    } else if (action === "set-inactive") {
        await updateRecipientStatus(id, false);
    } else if (action === "delete") {
        await deleteRecipient(id);
    }
});

async function addRecipient(event) {
    event.preventDefault();

    const nameInput = document.getElementById("recipientName");
    const mobileInput = document.getElementById("mobileNumber");

    const name = nameInput.value.trim();
    const mobile = mobileInput.value.trim();

    if (!name || !mobile) {
        setFormMessage("Enter both the recipient's name and mobile number.", "error");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Adding...";

    try {
        const { data, error } = await supabaseClient
            .from("recipients")
            .insert({
                name,
                mobile_number: mobile,
                email: null, // Kept null for compatibility with the existing database column.
                active: true
            })
            .select("id, name, mobile_number, active, created_at")
            .single();

        if (error) {
            throw error;
        }

        recipientForm.reset();
        setFormMessage(`${name} was added successfully.`, "ok");

        await queueWelcomeSms(data);
        await loadRecipients();

    } catch (error) {
        console.error("Add recipient error:", error);
        setFormMessage(`Could not add recipient: ${error.message}`, "error");
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Add Recipient";
    }
}

// Keep the existing SMS welcome-notification behavior. No email is collected
// or queued by this page.
async function queueWelcomeSms(recipient) {
    if (!recipient.mobile_number) {
        return;
    }

    const { error } = await supabaseClient
        .from("sms_queue")
        .insert({
            phone: recipient.mobile_number,
            message: `Hi ${recipient.name}, you've been added as a recipient for Flood Monitoring System alerts.`,
            status: "PENDING"
        });

    if (error) {
        console.error("Welcome SMS queue error:", error);
        setFormMessage(
            `${recipient.name} was added, but the welcome SMS could not be queued: ${error.message}`,
            "error"
        );
    }
}

async function updateRecipientStatus(id, active) {
    const recipient = recipientsById.get(String(id));

    if (!recipient || recipient.active === active) {
        return;
    }

    const actionButtons = Array.from(
        recipientBody.querySelectorAll("button[data-id]")
    ).filter(button => button.dataset.id === String(id));

    actionButtons.forEach(button => {
        button.disabled = true;
    });

    try {
        const { data, error } = await supabaseClient
            .from("recipients")
            .update({ active })
            .eq("id", recipient.id)
            .select("id, active")
            .maybeSingle();

        if (error) {
            throw error;
        }

        if (!data) {
            throw new Error("No record was updated. Check the recipients table permissions in Supabase.");
        }

        recipient.active = data.active;
        renderRecipientTable();

        setPageMessage(
            `${recipient.name} is now ${data.active ? "Active" : "Inactive"}.`,
            "ok"
        );

    } catch (error) {
        console.error("Update recipient status error:", error);
        setPageMessage(`Could not update status: ${error.message}`, "error");
        await loadRecipients();
    }
}

async function deleteRecipient(id) {
    const recipient = recipientsById.get(String(id));

    if (!recipient) {
        return;
    }

    const confirmed = confirm(
        `Delete ${recipient.name || "this recipient"}? This will remove the recipient from the registered list.`
    );

    if (!confirmed) {
        return;
    }

    try {
        const { data, error } = await supabaseClient
            .from("recipients")
            .delete()
            .eq("id", recipient.id)
            .select("id")
            .maybeSingle();

        if (error) {
            throw error;
        }

        if (!data) {
            throw new Error("No record was deleted. Check the recipients table permissions in Supabase.");
        }

        recipients = recipients.filter(item => String(item.id) !== String(id));
        recipientsById.delete(String(id));
        renderRecipientTable();

        setPageMessage(`${recipient.name} was deleted.`, "ok");

    } catch (error) {
        console.error("Delete recipient error:", error);
        setPageMessage(`Could not delete recipient: ${error.message}`, "error");
    }
}

async function initRecipientManagement() {
    if (await requireRole("moderator")) {
        await loadRecipients();
    }
}

initRecipientManagement();
