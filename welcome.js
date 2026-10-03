// Swaps the Log in / Sign up buttons for "Open dashboard" when the
// visitor already has a saved session. Reads the session straight
// from localStorage so the landing page doesn't have to load the
// Supabase library. The dashboard still verifies the session itself.

(function () {

    let signedIn = false;

    try {
        signedIn = Object.keys(localStorage).some(key => /^sb-.+-auth-token$/.test(key));
    } catch (error) {
        // Storage blocked (private mode, strict settings): show the default buttons.
    }

    if (!signedIn) {
        return;
    }

    document.querySelectorAll("[data-auth='out']").forEach(el => { el.hidden = true; });
    document.querySelectorAll("[data-auth='in']").forEach(el => { el.hidden = false; });

})();