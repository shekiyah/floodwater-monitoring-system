// supabaseClient, parseSupabaseTimestamp and escapeHtml come from
// supabase-config.js; requireRole comes from nav.js.

// Admin-only page. The role check is a UX guard; the RLS policies in
// ota-firmware-setup.sql are what actually enforce it.

const firmwareBody = document.getElementById("firmwareBody");
const uploadButton = document.getElementById("uploadButton");

// Rows by id, so the buttons only need to carry the id.
let firmwareById = new Map();

function showFirmwareMessage(text) {

    firmwareBody.innerHTML =
        `<tr class="table-empty"><td colspan="5">${escapeHtml(text)}</td></tr>`;
}

async function loadFirmwareList() {

    const { data, error } = await supabaseClient
        .from("firmware_updates")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Load firmware error:", error);
        showFirmwareMessage("Could not load firmware versions. Refresh the page to try again.");
        return;
    }

    firmwareById = new Map(data.map(fw => [String(fw.id), fw]));

    renderFirmwareTable(data);
}

function renderFirmwareTable(data) {

    if (data.length === 0) {
        showFirmwareMessage("No firmware uploaded yet. Upload a .bin file above to publish the first version.");
        return;
    }

    firmwareBody.innerHTML = data.map(fw => `
        <tr>
            <td>${escapeHtml(fw.version)}</td>
            <td>${escapeHtml(parseSupabaseTimestamp(fw.created_at).toLocaleString())}</td>
            <td class="td-text">${escapeHtml(fw.notes || "-")}</td>
            <td>
                <span class="pill ${fw.is_current ? "pill--on" : "pill--off"}">
                    ${fw.is_current ? "Current" : "Older"}
                </span>
            </td>
            <td>
                <div class="row-actions">
                    ${fw.is_current ? "" : `
                        <button type="button" class="btn btn--secondary btn--sm"
                                data-action="current" data-id="${escapeHtml(fw.id)}">Set as current</button>`}
                    <button type="button" class="btn btn--ghost-danger btn--sm"
                            data-action="delete" data-id="${escapeHtml(fw.id)}">Delete</button>
                </div>
            </td>
        </tr>
    `).join("");
}

firmwareBody.addEventListener("click", event => {

    const button = event.target.closest("button[data-action]");

    if (!button) {
        return;
    }

    if (button.dataset.action === "current") {
        setCurrentFirmware(button.dataset.id);
    } else if (button.dataset.action === "delete") {
        deleteFirmware(button.dataset.id);
    }
});

async function uploadFirmware(event) {

    event.preventDefault();

    const fileInput = document.getElementById("firmwareFile");
    const versionInput = document.getElementById("firmwareVersion");
    const notesInput = document.getElementById("firmwareNotes");
    const setCurrentCheckbox = document.getElementById("setCurrent");

    const file = fileInput.files[0];
    const version = versionInput.value.trim();
    const notes = notesInput.value.trim();

    if (!file || !version) {
        alert("Choose a .bin file and enter a version number.");
        return;
    }

    if (!file.name.endsWith(".bin")) {
        alert("The firmware file must be a compiled .bin file.");
        return;
    }

    uploadButton.disabled = true;
    uploadButton.textContent = "Uploading…";

    try {

        const filePath = `${Date.now()}_${file.name}`;

        const { error: uploadError } = await supabaseClient
            .storage
            .from("firmware")
            .upload(filePath, file);

        if (uploadError) {
            alert("Upload failed: " + uploadError.message);
            return;
        }

        const { data: urlData } = supabaseClient
            .storage
            .from("firmware")
            .getPublicUrl(filePath);

        const { data: inserted, error: insertError } = await supabaseClient
            .from("firmware_updates")
            .insert({
                version: version,
                file_path: filePath,
                file_url: urlData.publicUrl,
                notes: notes || null,
                is_current: false
            })
            .select()
            .single();

        if (insertError) {
            alert("The file uploaded but could not be recorded: " + insertError.message);
            return;
        }

        if (setCurrentCheckbox.checked) {
            await setCurrentFirmware(inserted.id);
        }

        event.target.reset();
        setCurrentCheckbox.checked = true;

        loadFirmwareList();

    } finally {
        uploadButton.disabled = false;
        uploadButton.textContent = "Upload and publish";
    }
}

async function setCurrentFirmware(id) {

    const { error: clearError } = await supabaseClient
        .from("firmware_updates")
        .update({ is_current: false })
        .neq("id", id);

    if (clearError) {
        alert(clearError.message);
        return;
    }

    const { error: setError } = await supabaseClient
        .from("firmware_updates")
        .update({ is_current: true })
        .eq("id", id);

    if (setError) {
        alert(setError.message);
        return;
    }

    loadFirmwareList();
}

async function deleteFirmware(id) {

    const fw = firmwareById.get(String(id));

    if (!fw) {
        return;
    }

    if (fw.is_current) {
        alert("Devices are running this version. Set another version as current before deleting it.");
        return;
    }

    if (!confirm(`Delete firmware ${fw.version}? This cannot be undone.`)) {
        return;
    }

    const { error: storageError } = await supabaseClient
        .storage
        .from("firmware")
        .remove([fw.file_path]);

    if (storageError) {
        console.error("Storage delete error:", storageError);
    }

    const { error: dbError } = await supabaseClient
        .from("firmware_updates")
        .delete()
        .eq("id", fw.id);

    if (dbError) {
        alert(dbError.message);
        return;
    }

    loadFirmwareList();
}

async function init() {

    if (await requireRole("admin", "This page is restricted to admins.")) {
        loadFirmwareList();
    }
}

init();