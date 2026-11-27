package com.approxtech.ai;

import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.GraphicsMode;

/** Runs the real MainActivity (compiled from android/src, resources from the built APK) headless. */
@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@org.robolectric.annotation.Config(sdk = 33)
public class AppScreensTest {

    static List<View> all(View v, List<View> out) {
        out.add(v);
        if (v instanceof ViewGroup) { ViewGroup g = (ViewGroup) v; for (int i = 0; i < g.getChildCount(); i++) all(g.getChildAt(i), out); }
        return out;
    }
    static List<View> all(View v) { return all(v, new ArrayList<>()); }
    static TextView textView(View root, String text) {
        for (View v : all(root)) if (v instanceof TextView && !(v instanceof EditText) && text.contentEquals(((TextView) v).getText())) return (TextView) v;
        return null;
    }
    static List<String> hints(View root) {
        List<String> h = new ArrayList<>();
        for (View v : all(root)) if (v instanceof EditText && ((EditText) v).getHint() != null) h.add(((EditText) v).getHint().toString());
        return h;
    }
    static void shot(View root, String name) throws Exception {
        String dir = System.getProperty("shots");
        if (dir == null || dir.isEmpty()) return;
        root.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2160, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, 1080, 2160);
        Bitmap b = Bitmap.createBitmap(1080, 2160, Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(b));
        try (FileOutputStream o = new FileOutputStream(new File(dir, name))) { b.compress(Bitmap.CompressFormat.PNG, 100, o); }
    }
    static void idle() { shadowOf(Looper.getMainLooper()).idleFor(1100, TimeUnit.MILLISECONDS); }   // past the 0.9 s splash
    static Object get(Object o, String f) throws Exception { java.lang.reflect.Field x = MainActivity.class.getDeclaredField(f); x.setAccessible(true); return x.get(o); }
    static void set(Object o, String f, Object v) throws Exception { java.lang.reflect.Field x = MainActivity.class.getDeclaredField(f); x.setAccessible(true); x.set(o, v); }

    @Test
    public void freshInstallOpensSignInDirectly_greenWhite_noServerField() throws Exception {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        idle();
        View root = a.findViewById(android.R.id.content);
        // Fresh install: straight to sign-in. No server/URL input anywhere.
        assertNotNull("Sign-in title shown", textView(root, "Welcome back"));
        List<String> h = hints(root);
        assertTrue("email + password fields: " + h, h.contains("Email") && h.contains("Password"));
        for (String x : h) assertFalse("no server/URL field: " + x, x.toLowerCase().contains("server") || x.contains("http"));
        for (View v : all(root)) if (v instanceof TextView) assertFalse("no server text on startup", ((TextView) v).getText().toString().toLowerCase().contains("server address"));
        assertEquals("API base is the production origin", "https://approx-ai.vercel.app", ((Api) get(a, "api")).getBase());
        // Theme: white background, Approx-green primary button with a pressed state, white label.
        assertEquals(0xFFFFFFFF, MainActivity.BG);
        TextView signIn = textView(root, "Sign in");
        assertNotNull("Sign in button", signIn);
        assertTrue("primary button has pressed state", signIn.getBackground() instanceof StateListDrawable);
        assertEquals("button label white on green", 0xFFFFFFFF, signIn.getCurrentTextColor());
        // Logo: transparent mark (no dark tile).
        ImageView logo = null;
        for (View v : all(root)) if (v instanceof ImageView) { logo = (ImageView) v; break; }
        assertNotNull(logo);
        assertEquals("in-app logo is the transparent mark", R.drawable.logo_mark, shadowOf(logo.getDrawable()).getCreatedFromResId());
        shot(root, "android-01-login.png");

        // Press feedback: installed on tappable views; finger down scales the button, release returns it.
        assertEquals(Boolean.TRUE, signIn.getTag(R.id.press_fx));
        long t = SystemClock.uptimeMillis();
        signIn.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, 10, 10, 0));
        shadowOf(Looper.getMainLooper()).idleFor(200, TimeUnit.MILLISECONDS);
        assertEquals("pressed → scaled down", 0.96f, signIn.getScaleX(), 0.001f);
        signIn.dispatchTouchEvent(MotionEvent.obtain(t, t + 100, MotionEvent.ACTION_CANCEL, 10, 10, 0));
        shadowOf(Looper.getMainLooper()).idleFor(300, TimeUnit.MILLISECONDS);
        assertEquals("released → back to normal", 1f, signIn.getScaleX(), 0.001f);

        // Google + password toggle on sign-in.
        assertNotNull("Continue with Google", textView(root, "G   Continue with Google"));
        EditText pw = null;
        for (View v : all(root)) if (v instanceof EditText && "Password".contentEquals(((EditText) v).getHint())) pw = (EditText) v;
        assertNotNull(pw);
        assertTrue("hidden by default", (pw.getInputType() & android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD) == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        textView(root, "Show password").performClick();
        assertEquals("Show → visible", android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, pw.getInputType() & android.text.InputType.TYPE_MASK_VARIATION);
        assertNotNull(textView(root, "Hide password"));

        // Create account screen.
        textView(root, "Create account").performClick();
        idle();
        root = a.findViewById(android.R.id.content);
        assertNotNull(textView(root, "Create your account"));
        assertTrue(hints(root).contains("Email"));
        for (String x : hints(root)) assertFalse("no server field on sign-up", x.toLowerCase().contains("server"));
        assertTrue("confirm password field", hints(root).contains("Confirm password"));
        assertNotNull("Google on sign-up", textView(root, "G   Continue with Google"));
        assertNotNull(textView(root, "Already have an account? Sign in"));
        shot(root, "android-02-signup.png");
    }

    @Test
    public void chatScreen_greeting_composer() throws Exception {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        idle();
        set(a, "user", new JSONObject().put("email", "umer@example.com").put("display_name", "Umer").put("email_verified", true).put("role", "user"));
        set(a, "models", new JSONArray()
            .put(new JSONObject().put("id", "nick-4.8").put("name", "Nick 4.8").put("available", true).put("tier", "default"))
            .put(new JSONObject().put("id", "hike-6.5").put("name", "Hike 6.5").put("available", true).put("tier", "advanced"))
            .put(new JSONObject().put("id", "sona-9.0").put("name", "Sona 9.0").put("available", false).put("tier", "premium"))
            .put(new JSONObject().put("id", "fab-100x").put("name", "FAB 100x").put("available", false).put("tier", "restricted"))
            .put(new JSONObject().put("id", "fab-500x").put("name", "FAB 500X").put("available", false).put("tier", "restricted")));
        a.showChat(null);   // network refreshes run in the background; the screen is checked before they report back
        View root = a.findViewById(android.R.id.content);
        String text = "";
        for (View v : all(root)) if (v instanceof TextView) text += ((TextView) v).getText() + "\n";
        assertTrue("plain greeting: " + text, text.matches("(?s).*Good (morning|afternoon|evening), Umer.*") && text.contains("How can I help you today?"));
        for (String bad : new String[]{"Night owl", "late-night", "Late-night", "Midnight", "jam session"}) assertFalse("no decorative text: " + bad, text.contains(bad));
        boolean prompt = false;
        for (String h : hints(root)) if (h.equals("Type or hold to talk")) prompt = true;
        assertTrue("composer input present: " + hints(root), prompt);
        for (String m : new String[]{"Low", "Medium", "High", "Memory"}) assertNull("no extra bar in the chat (" + m + ")", textView(root, m));
        assertNotNull("composer: attach", textView(root, "+")); assertNotNull("composer: mic", textView(root, "🎤")); assertNotNull("composer: send", textView(root, "➤"));
        for (String b : new String[]{"Code", "Co Approx", "Education"}) assertNotNull("primary action " + b, textView(root, b));
        assertNotNull("hamburger menu", textView(root, "☰"));
        assertNull("no bottom tab bar (History is in the side menu)", textView(root, "History"));
        assertNull("no bottom tab bar (Settings is in the side menu)", textView(root, "Settings"));
        shot(root, "android-03-chat.png");
    }

    static MainActivity signedIn() throws Exception {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        idle();
        set(a, "user", new JSONObject().put("email", "umer@example.com").put("display_name", "Umer").put("email_verified", true).put("role", "user"));
        set(a, "models", new JSONArray().put(new JSONObject().put("id", "nick-4.8").put("name", "Nick 4.8").put("available", true).put("selectable", true)));
        return a;
    }

    @Test
    public void sideMenu_workspaces_sessions_verifyNotice() throws Exception {
        MainActivity a = signedIn();
        a.showChat(null);
        a.openDrawer();
        View menu = null;
        for (android.app.Dialog d : org.robolectric.shadows.ShadowDialog.getShownDialogs())
            if (d.isShowing()) { ViewGroup content = d.findViewById(android.R.id.content); menu = content.getChildAt(0); }
        assertNotNull("side menu opens", menu);
        for (String item : new String[]{"New chat", "Home", "Projects", "Code", "Co Approx", "Education", "Artifacts", "Scheduled", "Sessions", "Files", "Settings", "Recents"})
            assertNotNull("menu item " + item, textView(menu, item));
        ViewGroup scrim = (ViewGroup) menu;
        View panel = scrim.getChildAt(0);
        panel.setTranslationX(0);
        scrim.removeView(panel);   // drawn on its own: the dialog window has no real surface in a headless test
        shot(panel, "android-04-menu.png");

        View root = a.findViewById(android.R.id.content);
        a.workspaceHome("code");
        for (String t : new String[]{"Code", "DEVICES", "SESSIONS", "◷", "＋  New session"}) assertNotNull("Code screen: " + t, textView(root, t));
        boolean codeSearch = false; for (String h : hints(root)) if (h.equals("Search sessions")) codeSearch = true;
        assertTrue("Code: search sessions", codeSearch);
        for (String f : new String[]{"All", "Active", "Archived"}) assertNotNull("Code filter " + f, textView(root, f));
        shot(root, "android-05-code.png");
        for (String[] w : new String[][]{{"work", "Co Approx", "＋  New session"}, {"education", "Education", "＋  New study session"}}) {
            a.workspaceHome(w[0]);
            assertNotNull(w[0] + " title", textView(root, w[1]));
            assertNotNull(w[0] + " new session", textView(root, w[2]));
            boolean search = false;
            for (String h : hints(root)) if (h.equals("Search sessions")) search = true;
            assertTrue(w[0] + " search", search);
            assertNull(w[0] + " has no composer clutter", textView(root, "Medium"));
            shot(root, "android-05-" + w[0] + ".png");
        }
        // Overview sections rendered from a server response (the same JSON /api/workspaces/:kind returns).
        Workspaces ws = (Workspaces) get(a, "ws");
        LinearLayout body = new LinearLayout(a); body.setOrientation(LinearLayout.VERTICAL);
        ws.renderOverview("education", new JSONObject("{\"sessions\":[{\"id\":\"ses_1\",\"kind\":\"education\",\"title\":\"Class 11 CS — Chapter 4\",\"project\":{\"id\":\"prj_1\",\"name\":\"Class 11 CS\"},\"thread_count\":2,\"open_tasks\":1,\"updated_at\":1}],"
            + "\"projects\":[{\"id\":\"prj_1\",\"name\":\"Class 11 CS\",\"session_count\":1}],\"active_tasks\":[{\"id\":\"tsk_1\",\"session_id\":\"ses_1\",\"title\":\"Exercise 4.2\",\"kind\":\"assignment\",\"status\":\"todo\"}],"
            + "\"files\":[],\"artifacts\":[],\"connectors\":[{\"provider\":\"google_drive\",\"name\":\"Google Drive\",\"status\":\"not_configured\"}],"
            + "\"progress\":{\"quiz_attempts\":3,\"average_percent\":67,\"by_course\":[]}}"), body);
        for (String t : new String[]{"Progress", "Recent sessions", "Class 11 CS — Chapter 4", "Courses & subjects", "Assignments & tasks", "📝 Exercise 4.2", "Documents & notes", "Outputs", "Connected apps", "Google Drive", "3 quiz attempts · 67% average"})
            assertNotNull("education overview: " + t, textView(body, t));
        // Session bar: threads as chips + the workspace's own tools.
        for (String[] k : new String[][]{{"code", "Changes", "Commit", "Branch", "Run / Test"}, {"education", "Documents", "Quiz", "Assignments", "Progress"}, {"work", "Tasks", "Plan", "Outputs", "Logs"}}) {
            ws.session = new JSONObject("{\"id\":\"ses_9\",\"kind\":\"" + k[0] + "\",\"title\":\"Session " + k[0] + "\",\"project\":{\"id\":\"prj_9\",\"name\":\"repo\"},"
                + "\"threads\":[{\"id\":\"cht_1\",\"title\":\"Main thread\"},{\"id\":\"cht_2\",\"title\":\"Bug #12\"}],\"tasks\":[],\"files\":[],\"artifacts\":[],\"logs\":[]}");
            View bar = ws.sessionBar("cht_2");
            for (String t : new String[]{"Session " + k[0], "Session ▾", "Main thread", "Bug #12", "＋ Thread", k[1], k[2], k[3], k[4]}) assertNotNull(k[0] + " bar: " + t, textView(bar, t));
            if (k[0].equals("code")) { set(a, "chatId", "cht_2"); a.showChat("cht_2"); ((LinearLayout) get(a, "currentPage")).addView(bar, 2); shot(root, "android-08-code-session.png"); }
        }
        // An empty Education session offers teaching / test / MCQ prompts grounded in the uploaded material.
        set(a, "workspace", "education");
        a.showChat(null);
        set(a, "workspace", "education");
        LinearLayout list = (LinearLayout) get(a, "messageList");
        list.removeAllViews();
        list.addView(a.sessionIntro());
        for (String q : new String[]{"Teach me this chapter step by step, like a teacher", "Make a test from this material with an answer key", "Create 10 MCQs with answers"})
            assertNotNull("education prompt " + q, textView(root, q));
        shot(root, "android-06-education-session.png");

        set(a, "user", null);
        a.showVerify("new.user@example.com", "If this email is new, a verification link is on its way (check Spam too).");
        assertNotNull("sign-up answer stays on screen", textView(root, "Sent to new.user@example.com.\nIf this email is new, a verification link is on its way (check Spam too).\nIt can take a minute. Check Spam and Promotions too."));
        TextView resend = null;
        for (View v : all(root)) if (v instanceof TextView && ((TextView) v).getText().toString().startsWith("Resend code")) resend = (TextView) v;
        assertNotNull(resend);
        assertFalse("resend waits out the 60 s email cooldown", resend.isEnabled());
        shot(root, "android-07-verify.png");
    }

    /** Polls the main looper until a text is on screen (network results arrive from the app's thread pool). */
    static TextView waitFor(View root, String text) throws Exception {
        for (int i = 0; i < 200; i++) { idle(); TextView t = textView(root, text); if (t != null) return t; Thread.sleep(25); }
        fail("not shown: " + text); return null;
    }
    static JSONObject serverSettings(Api api) throws Exception { return api.get("/api/settings").getJSONObject("settings"); }
    static void until(java.util.concurrent.Callable<Boolean> c, String what) throws Exception {
        for (int i = 0; i < 200; i++) { idle(); if (c.call()) return; Thread.sleep(25); }
        fail("server state never became: " + what);
    }

    /** End-to-end: the real MainActivity against a real local backend (backend/test/serve-for-android.mjs). Every
     *  Android settings control is tapped and the change is read back from the SERVER, not from the screen. */
    @Test
    public void settings_endToEnd_againstRealBackend() throws Exception {
        String e2e = System.getProperty("e2e");
        org.junit.Assume.assumeTrue("set APPROX_E2E (run.sh starts the local backend)", e2e != null && e2e.startsWith("{"));
        JSONObject cfg = new JSONObject(e2e);
        final Api api = new Api(cfg.getString("base"), cfg.getString("token"));
        MainActivity a = signedIn();
        set(a, "api", api);
        View root = a.findViewById(android.R.id.content);
        SettingsMore more = (SettingsMore) get(a, "more");

        more.notifications();
        waitFor(root, "Task and code updates");
        for (View v : all(root)) if (v instanceof android.widget.Switch && "Email me a copy".contentEquals(((android.widget.Switch) v).getText())) v.performClick();
        until(() -> !serverSettings(api).getBoolean("notifications_email"), "notifications_email=false");
        shot(root, "android-10-notifications.png");

        more.appearance();
        waitFor(root, "○  Large").performClick();
        until(() -> "large".equals(serverSettings(api).getString("text_size")), "text_size=large");
        waitFor(root, "●  Large");
        assertEquals(1.15f, (float) get(a, "textScale"), 0.001f);
        waitFor(root, "○  Approx Education").performClick();
        until(() -> "education".equals(serverSettings(api).getString("default_workspace")), "default_workspace=education");
        shot(root, "android-11-appearance.png");
        waitFor(root, "○  Medium").performClick();
        until(() -> "medium".equals(serverSettings(api).getString("text_size")), "text_size=medium");
        waitFor(root, "●  Medium");   // the page re-renders from the server after each save

        more.workspaces();
        waitFor(root, "○  10 questions").performClick();
        until(() -> serverSettings(api).getJSONObject("workspace_prefs").getJSONObject("education").getInt("quiz_count") == 10, "quiz_count=10");
        waitFor(root, "●  10 questions");
        waitFor(root, "○  Automatic — apply changes immediately").performClick();
        until(() -> "automatic".equals(serverSettings(api).getString("permissions_mode")), "permissions_mode=automatic");
        waitFor(root, "●  Automatic — apply changes immediately");
        shot(root, "android-12-workspaces.png");

        more.languageAndStyle();
        waitFor(root, "○  Roman Urdu").performClick();
        until(() -> "roman-ur".equals(api.get("/api/settings").getJSONObject("user").getString("language")), "language=roman-ur");
        waitFor(root, "●  Roman Urdu");

        more.dataControls();
        waitFor(root, "○  30 days").performClick();
        idle();
        android.app.AlertDialog dlg = (android.app.AlertDialog) org.robolectric.shadows.ShadowDialog.getLatestDialog();
        assertNotNull("retention asks for confirmation", dlg);
        dlg.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();
        until(() -> serverSettings(api).getInt("chat_retention_days") == 30, "chat_retention_days=30");
        waitFor(root, "●  30 days");
        shot(root, "android-13-data.png");

        a.securitySettings();
        waitFor(root, "Set up two-step verification");
        waitFor(root, "Signed-in devices");
        shot(root, "android-14-security.png");
    }

    static View dialogRoot() {
        android.app.Dialog d = org.robolectric.shadows.ShadowDialog.getLatestDialog();
        return d == null ? null : d.getWindow().getDecorView();
    }
    static TextView waitForInDialog(String text) throws Exception {
        for (int i = 0; i < 200; i++) { idle(); View r = dialogRoot(); TextView t = r == null ? null : textView(r, text); if (t != null) return t; Thread.sleep(25); }
        fail("dialog never showed: " + text); return null;
    }

    /** End-to-end: a code session's Agent tool proposes, the person approves on Android, the server applies it; Education flashcards. */
    @Test
    public void workspaces_agentReview_and_flashcards_endToEnd() throws Exception {
        String e2e = System.getProperty("e2e");
        org.junit.Assume.assumeTrue("set APPROX_E2E", e2e != null && e2e.startsWith("{"));
        JSONObject cfg = new JSONObject(e2e);
        final Api api = new Api(cfg.getString("base"), cfg.getString("token"));
        api.request("PATCH", "/api/settings", new JSONObject().put("permissions_mode", "manual"));
        final String pid = api.post("/api/workspaces/code/projects", new JSONObject().put("name", "android-e2e")).getJSONObject("project").getString("id");
        String sid = api.post("/api/work-sessions", new JSONObject().put("workspace", "code").put("project_id", pid)).getJSONObject("session").getString("id");
        MainActivity a = signedIn();
        set(a, "api", api);
        View root = a.findViewById(android.R.id.content);
        Workspaces ws = (Workspaces) get(a, "ws");
        ws.open(sid, null);
        waitFor(root, "Agent").performClick();                     // session bar tool
        View d = dialogRoot();
        for (View v : all(d)) if (v instanceof EditText) ((EditText) v).setText("Add a NOTES file");
        waitForInDialog("Propose changes").performClick();
        waitForInDialog("Approve & apply");
        assertNotNull("pending proposal listed", waitForInDialog("+ NOTES.md"));
        assertEquals("manual permissions: nothing written yet", 0, api.get("/api/fabbox/" + pid + "/files").getJSONArray("files").length());
        waitForInDialog("Approve & apply").performClick();
        until(() -> api.get("/api/fabbox/" + pid + "/files").getJSONArray("files").length() == 1, "NOTES.md applied by the server");

        String esid = api.post("/api/work-sessions", new JSONObject().put("workspace", "education").put("title", "Android flashcards")).getJSONObject("session").getString("id");
        ws.open(esid, null);
        waitFor(root, "Flashcards").performClick();
        ((android.app.AlertDialog) org.robolectric.shadows.ShadowDialog.getLatestDialog()).getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick();
        TextView counter = waitForInDialog("Card 1 of 2 · tap to flip");
        assertNotNull(counter);
        assertNotNull("front shown", textView(dialogRoot(), "Simulator term 1"));
        textView(dialogRoot(), "Simulator term 1").performClick();
        assertNotNull("tap flips to the answer", waitForInDialog("Simulator definition 1"));
    }

    static void clickDialogItem(int i) { android.app.AlertDialog d = (android.app.AlertDialog) org.robolectric.shadows.ShadowDialog.getLatestDialog(); d.getListView().performItemClick(d.getListView().getChildAt(i), i, i); idle(); }
    /** Taps a text the way a finger would: the nearest view that handles clicks (a row's container, not its label). */
    static void tap(View v) { while (v != null && !v.hasOnClickListeners() && v.getParent() instanceof View) v = (View) v.getParent(); v.performClick(); idle(); }
    static void positive() { ((android.app.AlertDialog) org.robolectric.shadows.ShadowDialog.getLatestDialog()).getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick(); idle(); }
    static EditText editByHint(View root, String hint) throws Exception {
        for (int t = 0; t < 80; t++) {
            idle();
            List<View> roots = new ArrayList<>();
            if (root != null) roots.add(root);
            for (android.app.Dialog d : org.robolectric.shadows.ShadowDialog.getShownDialogs()) if (d.isShowing()) roots.add(d.getWindow().getDecorView());
            for (View r : roots) for (View v : all(r)) if (v instanceof EditText && hint.equals(String.valueOf(((EditText) v).getHint()))) return (EditText) v;
            Thread.sleep(25);
        }
        fail("no field " + hint); return null;
    }

    /** End-to-end navigation against a real local backend: Code (devices + sessions, resume after reopening the app,
     *  search, filter), Scheduled (empty state + create), Artifacts, Co Approx and Education sessions. */
    @Test
    public void navigation_endToEnd_againstRealBackend() throws Exception {
        String e2e = System.getProperty("e2e");
        org.junit.Assume.assumeTrue("set APPROX_E2E", e2e != null && e2e.startsWith("{"));
        JSONObject cfg = new JSONObject(e2e);
        final Api api = new Api(cfg.getString("base"), cfg.getString("token"));
        MainActivity a = signedIn(); set(a, "api", api);
        View root = a.findViewById(android.R.id.content);
        Hub hub = (Hub) get(a, "hub");
        // 1–2. Code → Add device: a real pairing code from the server.
        hub.code();
        tap(waitFor(root, "＋  Add device"));
        editByHint(dialogRoot(), "Device name (e.g. Work laptop)").setText("Robo laptop");
        positive();
        waitFor(root, "PAIRING CODE");
        until(() -> { JSONArray ds = api.get("/api/devices").getJSONArray("devices"); for (int i = 0; i < ds.length(); i++) if ("Robo laptop".equals(ds.getJSONObject(i).getString("name"))) return true; return false; }, "pending device on the server");
        assertNotNull(waitFor(root, "Waiting for the device to connect…"));
        shot(root, "android-15-add-device.png");
        // 3. New Code session: repository → branch/device → start.
        api.post("/api/workspaces/code/projects", new JSONObject().put("name", "robo-repo"));
        hub.newCodeSession();
        waitForInDialog("robo-repo");
        clickDialogItem(0);
        waitForInDialog("Start session");
        editByHint(dialogRoot(), "Session title (optional)").setText("Fix login bug");
        positive();
        until(() -> { JSONArray ss = api.get("/api/session-history?workspace=code").getJSONArray("sessions"); for (int i = 0; i < ss.length(); i++) if ("Fix login bug".equals(ss.getJSONObject(i).getString("title"))) return true; return false; }, "code session on the server");
        // 4–6. Close the app, reopen it, find the session in Code and resume it.
        MainActivity b = signedIn(); set(b, "api", api);
        View root2 = b.findViewById(android.R.id.content);
        ((Hub) get(b, "hub")).code();
        tap(waitFor(root2, "Fix login bug"));
        waitFor(root2, "Session ▾");
        assertNotNull("resumed session bar", waitFor(root2, "Main thread"));
        shot(root2, "android-16-code-session.png");
        // 7–8. Search and filter.
        Hub hb = (Hub) get(b, "hub");
        hb.code("all", "nothing-matches-this");
        waitFor(root2, "No session matches \"nothing-matches-this\".");
        hb.code("archived", null);
        waitFor(root2, "No sessions yet");
        // 9–11. Scheduled: empty state, create, appears.
        hb.scheduled();
        waitFor(root2, "No scheduled tasks yet");
        assertNotNull(textView(root2, "Scheduled tasks run automatically on their configured schedule."));
        shot(root2, "android-17-scheduled-empty.png");
        waitFor(root2, "＋  New task").performClick();
        editByHint(dialogRoot(), "Task name").setText("Daily standup notes");
        editByHint(dialogRoot(), "Instructions (what Approx should do each time)").setText("Summarise yesterday's sessions.");
        positive();
        waitFor(root2, "Daily standup notes");
        until(() -> api.get("/api/scheduled").getJSONArray("tasks").length() == 1, "scheduled task saved on the server");
        shot(root2, "android-18-scheduled.png");
        // 12–13. Artifacts: create, opens, listed.
        hb.artifacts(null);
        waitFor(root2, "＋  Create artifact").performClick();
        editByHint(dialogRoot(), "Title").setText("Release notes");
        editByHint(dialogRoot(), "Content (Markdown)").setText("# v1.7");
        positive();
        waitFor(root2, "Release notes");
        until(() -> api.get("/api/artifacts?q=Release").getJSONArray("artifacts").length() == 1, "artifact on the server");
        // 14–16. Co Approx: new session, then resume it from Sessions.
        b.workspaceHome("work");
        waitFor(root2, "＋  New session").performClick();
        waitForInDialog("Start session");
        editByHint(dialogRoot(), "Session title (optional)").setText("Competitor scan");
        positive();
        waitFor(root2, "Session ▾");
        hb.history("work", "recent");
        tap(waitFor(root2, "Competitor scan"));
        waitFor(root2, "Run task");
        // 17–18. Education: new study session.
        b.workspaceHome("education");
        waitFor(root2, "＋  New study session").performClick();
        waitForInDialog("Start session");
        editByHint(dialogRoot(), "Session title (e.g. Class 11 CS — Chapter 4)").setText("Class 11 CS — Chapter 4");
        positive();
        until(() -> api.get("/api/session-history?workspace=education").getJSONArray("sessions").length() >= 1, "study session on the server");
    }

    @Test
    public void recentAccountChooser_and_forgedGoogleReturnRejected() throws Exception {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        idle();
        java.lang.reflect.Method remember = MainActivity.class.getDeclaredMethod("rememberAccount", JSONObject.class);
        remember.setAccessible(true);
        remember.invoke(a, new JSONObject().put("email", "umer@example.com").put("display_name", "Umer"));
        java.lang.reflect.Method login = MainActivity.class.getDeclaredMethod("showLogin");
        login.setAccessible(true); login.invoke(a); idle();
        View root = a.findViewById(android.R.id.content);
        assertNotNull("chooser title", textView(root, "Choose an account"));
        TextView row = textView(root, "Umer\numer@example.com");
        assertNotNull("recent account row (no token/password shown)", row);
        row.performClick();
        EditText email = null; for (View v : all(root)) if (v instanceof EditText && "Email".contentEquals(((EditText) v).getHint())) email = (EditText) v;
        assertEquals("tap fills the email", "umer@example.com", email.getText().toString());
        // Forged return link: state does not match anything this app started → rejected, no session.
        a.onNewIntent(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("approxai://auth?code=stolen&state=forged")));
        idle();
        assertNull("no session from a forged link", ((Api) get(a, "api")).getToken());
        assertEquals("That sign-in link isn't valid. Please try again.", org.robolectric.shadows.ShadowToast.getTextOfLatestToast());
        shot(root, "android-00-login-chooser.png");
    }
}
