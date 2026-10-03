// supabaseClient comes from supabase-config.js; requireRole from nav.js.

// Admin + moderator only (the RLS policy on alert_messages is the
// real boundary; this guard just keeps viewers off the page).

const levelSelect = document.getElementById("level");
const messageField = document.getElementById("message");
const messageStatus = document.getElementById("messageStatus");
const saveButton = document.getElementById("saveButton");

function showMessageStatus(text, kind) {

    messageStatus.textContent = text;
    messageStatus.className = "form-status" + (kind ? " form-status--" + kind : "");
}

// Loads the saved wording for the selected level, so editing starts
// from what's there instead of a blank box that would overwrite it.
async function loadMessageForLevel() {

    showMessageStatus("Loading…");
    messageField.disabled = true;

    const { data, error } = await supabaseClient
        .from("alert_messages")
        .select("message")
        .eq("level", levelSelect.value)
        .maybeSingle();

    messageField.disabled = false;

    if (error) {
        console.error(error);
        messageField.value = "";
        showMessageStatus("Could not load the saved message for this level.", "error");
        return;
    }

    messageField.value = data ? data.message : "";
    showMessageStatus(data ? "" : "No message saved for this level yet.");
}

async function saveMessage(event) {

    event.preventDefault();

    const message = messageField.value.trim();

    if (!message) {
        showMessageStatus("Write a message before saving.", "error");
        return;
    }

    saveButton.disabled = true;
    showMessageStatus("Saving…");

    const { error } = await supabaseClient
        .from("alert_messages")
        .upsert({
            level: levelSelect.value,
            message: message,
            updated_at: new Date().toISOString()
        });

    saveButton.disabled = false;

    if (error) {
        console.error(error);
        showMessageStatus("Could not save: " + error.message, "error");
        return;
    }

    showMessageStatus(`Saved the ${levelSelect.value} message.`, "ok");
}

// Clicking a variable inserts it at the cursor.
document.querySelectorAll("[data-insert]").forEach(chip => {

    chip.addEventListener("click", () => {

        const token = chip.dataset.insert;
        const start = messageField.selectionStart;
        const end = messageField.selectionEnd;

        messageField.setRangeText(token, start, end, "end");
        messageField.focus();
    });
});

levelSelect.addEventListener("change", loadMessageForLevel);

async function init() {

    if (await requireRole("moderator")) {
        loadMessageForLevel();
    }
}

init();