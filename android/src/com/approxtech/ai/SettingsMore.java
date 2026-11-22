package com.approxtech.ai;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.text.InputType;
import android.text.format.DateUtils;
import android.view.View;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Android Settings that mirror the web (API 1.9) and change real server state: language, personalization,
 * notifications + inbox, appearance (text size, start screen), workspace preferences, Approx Code permissions,
 * data controls, two-step verification, signed-in devices. Every control PATCHes /api/settings (or its own endpoint)
 * and is re-read from the server, never only from local state.
 */
final class SettingsMore {
    private final MainActivity a;
    SettingsMore(MainActivity a) { this.a = a; }

    interface Load { void ok(JSONObject s); }
    void withSettings(final Load l) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/settings"); } },
                new MainActivity.Done() { public void ok(Object r) { l.ok((JSONObject) r); } });
    }
    void patch(final JSONObject body, final Runnable after) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("PATCH", "/api/settings", body); } },
                new MainActivity.Done() { public void ok(Object r) { a.toast("Saved"); if (after != null) after.run(); } });
    }
    TextView label(String s) { return a.text(s, 15, MainActivity.TEXT, true); }
    TextView note(String s) { return a.text(s, 13, MainActivity.MUTED, false); }

    /** A row of choices; the current one is marked ●. Saving re-opens the page from the server. */
    void choices(LinearLayout col, String title, String current, final String[] values, String[] labels, final ChoiceSave save) {
        a.add(col, label(title), 18);
        for (int i = 0; i < values.length; i++) {
            final String v = values[i];
            TextView t = a.text((v.equals(current) ? "●  " : "○  ") + labels[i], 15, v.equals(current) ? MainActivity.GREEN_TEXT : MainActivity.TEXT, v.equals(current));
            t.setPadding(0, a.dp(9), 0, a.dp(9));
            t.setContentDescription(title + ": " + labels[i]);
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View x) { save.save(v); } });
            col.addView(t);
        }
    }
    interface ChoiceSave { void save(String v); }

    Switch sw(String text, boolean on, final String key) {
        Switch s = new Switch(a);
        s.setText(text); s.setTextColor(MainActivity.TEXT); s.setTextSize(15); s.setChecked(on);
        s.setPadding(0, a.dp(12), 0, a.dp(12));
        s.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() { public void onCheckedChanged(CompoundButton b, boolean v) { patch(MainActivity.obj(key, v), null); } });
        return s;
    }

    // ---------------------------------------------------------------- profile: language + personalization
    void languageAndStyle() {
        final LinearLayout col = a.settingsPage("Language & personalization");
        withSettings(new Load() { public void ok(JSONObject r) {
            JSONObject u = r.optJSONObject("user"), s = r.optJSONObject("settings");
            choices(col, "Reply language", u.optString("language", "auto"), new String[]{"auto", "en", "ur", "roman-ur"},
                    new String[]{"Automatic (match my message)", "English", "اردو (Urdu)", "Roman Urdu"}, new ChoiceSave() { public void save(String v) {
                        patch(MainActivity.obj("language", v), new Runnable() { public void run() { languageAndStyle(); } }); } });
            a.add(col, label("How should Approx respond?"), 20);
            final EditText p = a.input("e.g. Keep answers short. I am a medical student.", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            p.setText(s.optString("personalization"));
            p.setMinLines(3);
            a.add(col, p, 8);
            a.add(col, a.button("Save", true, new Runnable() { public void run() { patch(MainActivity.obj("personalization", p.getText().toString()), null); } }), 8);
        } });
    }

    // ---------------------------------------------------------------- notifications
    void notifications() {
        final LinearLayout col = a.settingsPage("Notifications");
        withSettings(new Load() { public void ok(JSONObject r) {
            JSONObject s = r.optJSONObject("settings");
            a.add(col, sw("Task and code updates", s.optBoolean("notify_task_updates", true), "notify_task_updates"), 6);
            a.add(col, note("Plans and quizzes that are ready, code changes waiting for review."), 0);
            a.add(col, sw("Email me a copy", s.optBoolean("notifications_email", true), "notifications_email"), 8);
            a.add(col, note("Security notifications (new sign-in, password or two-step verification changes) are always shown and emailed."), 4);
            final LinearLayout inbox = a.vbox();
            LinearLayout actions = a.hbox();
            actions.addView(a.link("Mark all read", new Runnable() { public void run() { a.call("POST", "/api/notifications/read-all", new JSONObject(), new Runnable() { public void run() { notifications(); } }); } }));
            View sp = new View(a); actions.addView(sp, new LinearLayout.LayoutParams(0, 1, 1));
            actions.addView(a.link("Clear all", new Runnable() { public void run() {
                a.confirm("Clear all notifications?", "Your inbox will be emptied.", new Runnable() { public void run() { a.call("DELETE", "/api/notifications", null, new Runnable() { public void run() { notifications(); } }); } });
            } }));
            a.add(col, actions, 18);
            a.add(col, inbox, 4);
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/notifications"); } }, new MainActivity.Done() { public void ok(Object x) {
                JSONArray ns = ((JSONObject) x).optJSONArray("notifications");
                if (ns.length() == 0) inbox.addView(note("No notifications."));
                for (int i = 0; i < ns.length(); i++) {
                    final JSONObject n = ns.optJSONObject(i);
                    TextView t = a.text((n.isNull("read_at") ? "● " : "") + n.optString("title") + "\n" + n.optString("body") + " · " + DateUtils.getRelativeTimeSpanString(n.optLong("created_at")),
                            14, MainActivity.TEXT, n.isNull("read_at"));
                    t.setPadding(0, a.dp(10), 0, a.dp(10));
                    t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { a.call("POST", "/api/notifications/" + n.optString("id") + "/read", new JSONObject(), new Runnable() { public void run() { notifications(); } }); } });
                    t.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) {
                        a.call("DELETE", "/api/notifications/" + n.optString("id"), null, new Runnable() { public void run() { a.toast("Deleted"); notifications(); } }); return true; } });
                    inbox.addView(t);
                }
                if (ns.length() > 0) inbox.addView(note("Tap: mark read · long-press: delete"));
            } });
        } });
    }

    // ---------------------------------------------------------------- appearance
    void appearance() {
        final LinearLayout col = a.settingsPage("Appearance");
        withSettings(new Load() { public void ok(JSONObject r) {
            JSONObject s = r.optJSONObject("settings");
            choices(col, "Text size", s.optString("text_size", "medium"), new String[]{"small", "medium", "large"}, new String[]{"Small", "Medium", "Large"},
                    new ChoiceSave() { public void save(final String v) { patch(MainActivity.obj("text_size", v), new Runnable() { public void run() { a.setTextScale(v); appearance(); } }); } });
            choices(col, "Open Approx in", s.optString("default_workspace", "home"), new String[]{"home", "work", "code", "education"},
                    new String[]{"Home (chat)", "Approx Work", "Approx Code", "Approx Education"},
                    new ChoiceSave() { public void save(String v) { patch(MainActivity.obj("default_workspace", v), new Runnable() { public void run() { appearance(); } }); } });
            a.add(col, note("The Android app uses the light Approx theme. Dark and System themes apply to the web app."), 16);
        } });
    }

    // ---------------------------------------------------------------- workspaces (+ Approx Code permissions)
    void workspaces() {
        final LinearLayout col = a.settingsPage("Workspaces");
        withSettings(new Load() { public void ok(JSONObject r) {
            JSONObject s = r.optJSONObject("settings");
            JSONObject p = s.optJSONObject("workspace_prefs");
            JSONObject ed = p.optJSONObject("education"), code = p.optJSONObject("code"), work = p.optJSONObject("work");
            a.add(col, a.text("Approx Education", 17, MainActivity.TEXT, true), 8);
            choices(col, "Quiz length", String.valueOf(ed.optInt("quiz_count", 5)), new String[]{"3", "5", "10", "15", "20"}, new String[]{"3 questions", "5 questions", "10 questions", "15 questions", "20 questions"},
                    new ChoiceSave() { public void save(String v) { pref("education", "quiz_count", Integer.parseInt(v)); } });
            choices(col, "Quiz difficulty", ed.optString("difficulty"), new String[]{"easy", "mixed", "hard"}, new String[]{"Easy", "Mixed", "Hard"},
                    new ChoiceSave() { public void save(String v) { pref("education", "difficulty", v); } });
            choices(col, "Explanations", ed.optString("explanation_style"), new String[]{"simple", "detailed", "exam"},
                    new String[]{"Simple — short steps", "Detailed — full derivations", "Exam-focused — key points"}, new ChoiceSave() { public void save(String v) { pref("education", "explanation_style", v); } });
            a.add(col, a.text("Approx Code", 17, MainActivity.TEXT, true), 24);
            choices(col, "Agent permissions", s.optString("permissions_mode", "manual"), new String[]{"manual", "automatic"},
                    new String[]{"Manual — changes wait for my review", "Automatic — apply changes immediately"},
                    new ChoiceSave() { public void save(String v) { patch(MainActivity.obj("permissions_mode", v), new Runnable() { public void run() { workspaces(); } }); } });
            a.add(col, label("Default branch for new repositories"), 18);
            final EditText br = a.input("main", InputType.TYPE_CLASS_TEXT);
            br.setText(code.optString("default_branch", "main"));
            a.add(col, br, 6);
            a.add(col, a.button("Save branch", false, new Runnable() { public void run() { pref("code", "default_branch", br.getText().toString().trim()); } }), 6);
            a.add(col, a.text("Approx Work", 17, MainActivity.TEXT, true), 24);
            Switch t = new Switch(a);
            t.setText("A thread for each planned task"); t.setTextColor(MainActivity.TEXT); t.setTextSize(15); t.setChecked(work.optBoolean("plan_threads", true));
            t.setPadding(0, a.dp(12), 0, a.dp(12));
            t.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() { public void onCheckedChanged(CompoundButton b, boolean v) { pref("work", "plan_threads", v); } });
            a.add(col, t, 4);
        } });
    }
    void pref(String ws, String key, Object v) {
        try { patch(MainActivity.obj("workspace_prefs", new JSONObject().put(ws, new JSONObject().put(key, v))), new Runnable() { public void run() { workspaces(); } }); }
        catch (Exception e) { a.toast(e.getMessage()); }
    }

    // ---------------------------------------------------------------- data controls
    void dataControls() {
        final LinearLayout col = a.settingsPage("Data controls");
        withSettings(new Load() { public void ok(JSONObject r) {
            JSONObject s = r.optJSONObject("settings");
            choices(col, "Keep conversations", String.valueOf(s.optInt("chat_retention_days", 0)), new String[]{"0", "7", "30", "90", "365"},
                    new String[]{"Forever", "7 days", "30 days", "90 days", "1 year"}, new ChoiceSave() { public void save(final String v) {
                        if ("0".equals(v)) { patch(MainActivity.obj("chat_retention_days", 0), new Runnable() { public void run() { dataControls(); } }); return; }
                        a.confirm("Delete old conversations?", "Conversations and sessions untouched for longer than " + v + " days will be deleted now and from now on.", new Runnable() { public void run() {
                            patch(MainActivity.obj("chat_retention_days", Integer.parseInt(v)), new Runnable() { public void run() { dataControls(); } }); } });
                    } });
            a.add(col, a.button("Archive all conversations", false, new Runnable() { public void run() {
                a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/account/data/archive-chats", new JSONObject()); } },
                        new MainActivity.Done() { public void ok(Object x) { a.toast(((JSONObject) x).optInt("count") + " conversations archived"); } });
            } }), 20);
            a.add(col, a.button("Export my data (opens the web app)", false, new Runnable() { public void run() { a.openWeb("/#/settings/data"); } }), 8);
            a.add(col, a.button("Delete all conversations", false, new Runnable() { public void run() {
                final EditText t = a.input("Type DELETE", InputType.TYPE_CLASS_TEXT);
                new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Delete all conversations?")
                        .setMessage("Every conversation and work session is permanently deleted.").setView(t)
                        .setPositiveButton("Delete", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                            final JSONObject b = MainActivity.obj("confirm", t.getText().toString().trim());
                            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/account/data/delete-chats", b); } },
                                    new MainActivity.Done() { public void ok(Object x) { a.toast(((JSONObject) x).optInt("count") + " conversations deleted"); } });
                        } }).setNegativeButton("Cancel", null).show();
            } }), 8);
        } });
    }

    // ---------------------------------------------------------------- security: two-step verification + devices
    void security(final LinearLayout col) {
        final LinearLayout mfa = a.vbox();
        a.add(col, a.text("Two-step verification", 17, MainActivity.TEXT, true), 24);
        a.add(col, mfa, 4);
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/auth/mfa"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONObject st = (JSONObject) r;
            if (!st.optBoolean("available")) { mfa.addView(note("This account signs in with Google. Set a password with “Forgot password” to use two-step verification.")); return; }
            final EditText pw = a.input("Current password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            final EditText code = a.input("6-digit code", InputType.TYPE_CLASS_NUMBER);
            if (st.optBoolean("enabled")) {
                mfa.addView(note("On — signing in needs a code from your authenticator app."));
                a.add(mfa, pw, 8); a.add(mfa, code, 6);
                a.add(mfa, a.button("Turn off", false, new Runnable() { public void run() {
                    final JSONObject b = MainActivity.obj("password", pw.getText().toString(), "code", code.getText().toString().trim());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/auth/mfa/disable", b); } },
                            new MainActivity.Done() { public void ok(Object x) { a.toast("Two-step verification turned off"); a.securitySettings(); } });
                } }), 8);
                return;
            }
            mfa.addView(note("Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…) to every sign-in."));
            a.add(mfa, pw, 8);
            a.add(mfa, a.button("Set up two-step verification", true, new Runnable() { public void run() {
                final JSONObject b = MainActivity.obj("password", pw.getText().toString());
                a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/auth/mfa/enroll", b); } }, new MainActivity.Done() { public void ok(Object x) {
                    final JSONObject e = (JSONObject) x;
                    mfa.removeAllViews();
                    mfa.addView(note("1. Add Approx to your authenticator app: open it on this phone, or enter the setup key."));
                    TextView key = a.text(e.optString("secret"), 15, MainActivity.TEXT, true);
                    key.setTextIsSelectable(true);
                    a.add(mfa, key, 6);
                    a.add(mfa, a.link("Open in authenticator app", new Runnable() { public void run() {
                        try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(e.optString("uri")))); } catch (Exception ex) { a.toast("No authenticator app found — enter the setup key manually."); }
                    } }), 4);
                    a.add(mfa, a.link("Copy setup key", new Runnable() { public void run() { a.copyClip("Setup key", e.optString("secret")); } }), 2);
                    a.add(mfa, note("2. Enter the 6-digit code the app shows."), 10);
                    a.add(mfa, code, 6);
                    a.add(mfa, a.button("Confirm and turn on", true, new Runnable() { public void run() {
                        final JSONObject v = MainActivity.obj("password", b.optString("password"), "factor_id", e.optString("factor_id"), "code", code.getText().toString().trim());
                        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/auth/mfa/verify", v); } },
                                new MainActivity.Done() { public void ok(Object y) { a.toast("Two-step verification is on"); a.securitySettings(); } });
                    } }), 8);
                } });
            } }), 8);
        } });

        final LinearLayout devices = a.vbox();
        a.add(col, a.text("Signed-in devices", 17, MainActivity.TEXT, true), 24);
        a.add(col, devices, 4);
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/auth/sessions"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            for (int i = 0; i < ss.length(); i++) {
                final JSONObject x = ss.optJSONObject(i);
                LinearLayout row = a.hbox();
                row.setPadding(0, a.dp(8), 0, a.dp(8));
                TextView t = a.text(("mobile".equals(x.optString("client")) ? "Android app" : "Web") + (x.optBoolean("current") ? " (this device)" : "") + "\n"
                        + "last active " + DateUtils.getRelativeTimeSpanString(x.optLong("last_seen_at")), 14, MainActivity.TEXT, x.optBoolean("current"));
                row.addView(t, new LinearLayout.LayoutParams(0, -2, 1));
                if (!x.optBoolean("current")) row.addView(a.link("Sign out", new Runnable() { public void run() {
                    a.call("DELETE", "/api/auth/sessions/" + x.optString("id"), null, new Runnable() { public void run() { a.toast("Signed out that device"); a.securitySettings(); } });
                } }));
                devices.addView(row);
            }
        } });
    }
}
