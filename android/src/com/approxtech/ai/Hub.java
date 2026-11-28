package com.approxtech.ai;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Main-menu destinations (API 1.10): Code (devices + sessions), Session history, Scheduled, Artifacts, Co Approx.
 * Every list is read from the server and every action writes to it; empty states say so plainly.
 */
final class Hub {
    private final MainActivity a;
    Hub(MainActivity a) { this.a = a; }
    int dp(int v) { return a.dp(v); }

    // ================================================================= shared bits
    TextView header(String s) { TextView t = a.text(s.toUpperCase(), 12.5f, MainActivity.MUTED, true); t.setLetterSpacing(0.06f); return t; }
    TextView muted(String s) { TextView t = a.text(s, 14, MainActivity.MUTED, false); t.setPadding(0, dp(6), 0, dp(6)); return t; }
    String ago(long t) { return t <= 0 ? "" : DateUtils.getRelativeTimeSpanString(t).toString(); }

    View row(String title, String sub, String badge, final Runnable tap, final Runnable longTap) {
        LinearLayout r = a.hbox();
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(14), dp(12), dp(14), dp(12));
        r.setBackground(a.pressable(a.bgShape(MainActivity.SURFACE, 16, MainActivity.LINE), a.bgShape(MainActivity.SURFACE3, 16, MainActivity.LINE)));
        LinearLayout tx = a.vbox();
        TextView t = a.text(title, 15.5f, MainActivity.TEXT, true); t.setMaxLines(2);
        tx.addView(t);
        if (sub != null && sub.length() > 0) tx.addView(a.text(sub, 12.5f, MainActivity.MUTED, false));
        r.addView(tx, new LinearLayout.LayoutParams(0, -2, 1));
        if (badge != null) {
            TextView b = a.text(badge, 11.5f, "running".equals(badge) || "online".equals(badge) || "enabled".equals(badge) ? MainActivity.GREEN_TEXT : MainActivity.MUTED, true);
            b.setPadding(dp(8), dp(3), dp(8), dp(3));
            b.setBackground(a.bgShape(MainActivity.SURFACE2, 999, MainActivity.LINE));
            r.addView(b);
        }
        if (tap != null) { r.setClickable(true); r.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { tap.run(); } }); }
        if (longTap != null) r.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { longTap.run(); return true; } });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(8);
        r.setLayoutParams(lp);
        return r;
    }

    /** Floating primary action, bottom-right, above the page (removed by the next shell()). */
    void fab(String label, final Runnable r) {
        TextView f = a.text("＋  " + label, 15, MainActivity.ON_GREEN, true);
        f.setPadding(dp(20), dp(14), dp(22), dp(14));
        f.setBackground(a.pressable(a.bgShape(MainActivity.GREEN, 999, MainActivity.GREEN), a.bgShape(MainActivity.GREEN_STRONG, 999, MainActivity.GREEN_STRONG)));
        f.setElevation(dp(6));
        f.setContentDescription(label);
        f.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } });
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
        lp.setMargins(0, 0, dp(18), dp(22));
        a.root().addView(f, lp);
    }

    LinearLayout page(String title, String actionGlyph, String actionDesc, Runnable action) {
        LinearLayout col = a.vbox();
        col.setPadding(dp(16), dp(10), dp(16), dp(96));
        ScrollView sv = new ScrollView(a);
        sv.addView(col);
        a.workspace = null; a.chatId = null;
        a.shell(sv, false);
        if (a.titleView != null) a.titleView.setText(title);
        a.setTopAction(actionGlyph, actionDesc, action);
        return col;
    }

    // ================================================================= Code: devices + sessions
    void code() { code("all", null); }

    void code(final String filter, final String q) {
        final LinearLayout col = page("Approx Code", "◷", "Session history", new Runnable() { public void run() { history("code", "recent"); } });
        col.addView(header("Devices"));
        final LinearLayout devices = a.vbox();
        col.addView(devices);
        a.add(col, header("Sessions"), 22);
        final EditText search = a.input("Search sessions", InputType.TYPE_CLASS_TEXT);
        if (q != null) search.setText(q);
        search.setOnEditorActionListener(new TextView.OnEditorActionListener() { public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) { code(filter, search.getText().toString()); return true; } });
        a.add(col, search, 8);
        HorizontalScrollView hs = new HorizontalScrollView(a); hs.setHorizontalScrollBarEnabled(false);
        LinearLayout chips = a.hbox();
        for (final String[] f : new String[][]{{"all", "All"}, {"active", "Active"}, {"archived", "Archived"}}) {
            TextView c = a.ws.chip(f[1], f[0].equals(filter));
            c.setContentDescription("Filter: " + f[1]);
            c.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { code(f[0], search.getText().toString()); } });
            chips.addView(c);
        }
        hs.addView(chips);
        a.add(col, hs, 8);
        final LinearLayout list = a.vbox();
        col.addView(list);
        fab("New session", new Runnable() { public void run() { newCodeSession(); } });

        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/devices"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ds = ((JSONObject) r).optJSONArray("devices");
            if (ds.length() == 0) devices.addView(muted("No devices connected"));
            for (int i = 0; i < ds.length(); i++) {
                final JSONObject d = ds.optJSONObject(i);
                String st = "pending".equals(d.optString("status")) ? "pending" : d.optBoolean("online") ? "online" : "offline";
                devices.addView(row(d.optString("name"), (d.optString("hostname").length() > 0 ? d.optString("hostname") + " · " : "") + (d.optLong("last_seen_at") > 0 ? "seen " + ago(d.optLong("last_seen_at")) : "not seen yet"), st,
                        null, new Runnable() { public void run() { deviceMenu(d); } }));
            }
            devices.addView(row("＋  Add device", "Run Code commands on your own computer", null, new Runnable() { public void run() { addDevice(); } }, null));
        } });
        final String view = "all".equals(filter) ? "recent" : filter;
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            return a.api.get("/api/session-history?workspace=code&view=" + view + (q != null && q.length() > 0 ? "&q=" + Api.enc(q) : ""));
        } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            if (ss.length() == 0) { list.addView(muted(q != null && q.length() > 0 ? "No session matches \"" + q + "\"." : "No sessions yet")); return; }
            for (int i = 0; i < ss.length(); i++) list.addView(sessionRow(ss.optJSONObject(i)));
        } });
    }

    View sessionRow(final JSONObject s) {
        StringBuilder sub = new StringBuilder();
        if (!s.isNull("project")) sub.append(s.optJSONObject("project").optString("name"));
        if (s.optString("branch").length() > 0 && !"null".equals(s.optString("branch"))) sub.append(sub.length() > 0 ? " · " : "").append("⎇ ").append(s.optString("branch"));
        if (!s.isNull("device")) sub.append(" · ").append(s.optJSONObject("device").optString("name"));
        sub.append(sub.length() > 0 ? " · " : "").append(s.optString("workspace")).append(" · ").append(ago(s.optLong("last_activity")));
        return row(s.optString("title"), sub.toString(), s.optString("status"), new Runnable() { public void run() { a.ws.open(s.optString("id"), null); } },
                new Runnable() { public void run() { a.ws.session = s; a.ws.sessionMenu(); } });
    }

    void deviceMenu(final JSONObject d) {
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(d.optString("name")).setItems(new String[]{"Rename", "Remove device"}, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface x, int w) {
                if (w == 0) {
                    final EditText e = a.input("Device name", InputType.TYPE_CLASS_TEXT); e.setText(d.optString("name"));
                    new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Rename device").setView(a.ws.pad(e)).setPositiveButton("Save", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface y, int z) { a.call("PATCH", "/api/devices/" + d.optString("id"), MainActivity.obj("name", e.getText().toString()), new Runnable() { public void run() { code(); } }); } })
                            .setNegativeButton("Cancel", null).show();
                } else a.confirm("Remove " + d.optString("name") + "?", "It stops receiving commands immediately; its token is revoked.", new Runnable() { public void run() {
                    a.call("DELETE", "/api/devices/" + d.optString("id"), null, new Runnable() { public void run() { a.toast("Device removed"); code(); } }); } });
            } }).show();
    }

    /** Real pairing: a one-time code + the command to run on the computer; the screen waits until the device connects. */
    void addDevice() {
        final EditText name = a.input("Device name (e.g. Work laptop)", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Add device").setView(a.ws.pad(name))
                .setMessage("Connect a computer that runs Node.js 18+. Commands you start in a Code session (Terminal, Run, Test, Build) then run there, on a copy of your repository.")
                .setPositiveButton("Get pairing code", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) {
                    final JSONObject b = MainActivity.obj("name", name.getText().toString().trim());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/devices", b); } }, new MainActivity.Done() { public void ok(Object r) { pairing((JSONObject) r); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void pairing(final JSONObject p) {
        final String devId = p.optJSONObject("device").optString("id");
        final LinearLayout col = page("Add device", "✕", "Close", new Runnable() { public void run() { code(); } });
        col.addView(header("1 · On your computer, run"));
        final TextView cmd = a.text(p.optString("command"), 13, MainActivity.CODE_TEXT, false);
        cmd.setTypeface(Typeface.MONOSPACE); cmd.setTextIsSelectable(true);
        cmd.setPadding(dp(12), dp(10), dp(12), dp(10)); cmd.setBackground(a.bgShape(MainActivity.CODE_BG, 12, MainActivity.LINE));
        a.add(col, cmd, 8);
        a.add(col, a.button("Copy command", false, new Runnable() { public void run() { a.copyClip("Approx device command", p.optString("command")); } }), 8);
        a.add(col, header("Pairing code"), 20);
        TextView code = a.text(p.optString("pairing_code"), 30, MainActivity.TEXT, true);
        code.setLetterSpacing(0.15f); code.setTextIsSelectable(true);
        a.add(col, code, 4);
        a.add(col, muted("Valid for 10 minutes and works once."), 0);
        final TextView status = a.text("Waiting for the device to connect…", 15, MainActivity.MUTED, true);
        a.add(col, status, 20);
        final long until = System.currentTimeMillis() + 10 * 60_000;
        a.ui.postDelayed(new Runnable() { public void run() {
            final Runnable self = this;
            if (!status.isAttachedToWindow()) return;   // the person left this screen
            a.pool.execute(new Runnable() { public void run() {
                try {
                    JSONArray ds = a.api.get("/api/devices").optJSONArray("devices");
                    for (int i = 0; i < ds.length(); i++) {
                        final JSONObject d = ds.optJSONObject(i);
                        if (devId.equals(d.optString("id")) && "connected".equals(d.optString("status"))) {
                            a.ui.post(new Runnable() { public void run() { status.setText("✓ Connected: " + d.optString("name") + (d.optString("hostname").length() > 0 ? " (" + d.optString("hostname") + ")" : "")); status.setTextColor(MainActivity.GREEN_TEXT); a.toast("Device connected"); } });
                            return;
                        }
                    }
                } catch (Exception ignored) { }
                if (System.currentTimeMillis() < until) a.ui.postDelayed(self, 2500);
                else a.ui.post(new Runnable() { public void run() { status.setText("The code expired. Close this screen and add the device again."); } });
            } });
        } }, 2500);
    }

    /** New Code session: repository → branch → device (optional) → title → a new server session. */
    void newCodeSession() {
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject o = new JSONObject();
            o.put("projects", a.api.get("/api/workspaces/code").optJSONArray("projects"));
            o.put("devices", a.api.get("/api/devices").optJSONArray("devices"));
            return o;
        } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONArray ps = ((JSONObject) r).optJSONArray("projects");
            final JSONArray ds = ((JSONObject) r).optJSONArray("devices");
            if (ps.length() == 0) { a.ws.newProject("code", new Runnable() { public void run() { newCodeSession(); } }); return; }
            final String[] names = new String[ps.length()];
            for (int i = 0; i < ps.length(); i++) names[i] = ps.optJSONObject(i).optString("name");
            new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Repository").setItems(names, new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface x, int w) { chooseBranch(ps.optJSONObject(w), ds); } })
                    .setNeutralButton("New repository", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) { a.ws.newProject("code", new Runnable() { public void run() { newCodeSession(); } }); } })
                    .show();
        } });
    }

    void chooseBranch(final JSONObject project, final JSONArray devices) {
        final String pid = project.optString("id");
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/code/" + pid + "/branches"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONObject b = (JSONObject) r;
            LinearLayout box = a.vbox();
            final EditText title = a.input("Session title (optional)", InputType.TYPE_CLASS_TEXT);
            box.addView(title);
            a.add(box, a.text("Branch", 13, MainActivity.MUTED, true), 12);
            final RadioGroup brg = new RadioGroup(a);
            final List<String> branches = new ArrayList<>();
            JSONArray bs = b.optJSONArray("branches");
            for (int i = 0; i < bs.length(); i++) { RadioButton rb = new RadioButton(a); rb.setText(bs.optJSONObject(i).optString("name")); rb.setId(View.generateViewId()); brg.addView(rb); branches.add(bs.optJSONObject(i).optString("name")); if (bs.optJSONObject(i).optString("name").equals(b.optString("current"))) rb.setChecked(true); }
            box.addView(brg);
            a.add(box, a.text("Device", 13, MainActivity.MUTED, true), 12);
            final RadioGroup drg = new RadioGroup(a);
            final List<String> dids = new ArrayList<>();
            RadioButton none = new RadioButton(a); none.setText("No device (edit, review, commit)"); none.setId(View.generateViewId()); none.setChecked(true); drg.addView(none); dids.add(null);
            for (int i = 0; i < devices.length(); i++) {
                JSONObject d = devices.optJSONObject(i);
                if (!"connected".equals(d.optString("status"))) continue;
                RadioButton rb = new RadioButton(a); rb.setText(d.optString("name") + (d.optBoolean("online") ? " · online" : " · offline")); rb.setId(View.generateViewId()); drg.addView(rb); dids.add(d.optString("id"));
            }
            box.addView(drg);
            new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("New session · " + project.optString("name")).setView(a.ws.scroll(a.ws.pad(box)))
                    .setPositiveButton("Start session", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) {
                        String branch = null, device = null;
                        for (int i = 0; i < brg.getChildCount(); i++) if (((RadioButton) brg.getChildAt(i)).isChecked()) branch = branches.get(i);
                        for (int i = 0; i < drg.getChildCount(); i++) if (((RadioButton) drg.getChildAt(i)).isChecked()) device = dids.get(i);
                        final JSONObject body = MainActivity.obj("workspace", "code", "project_id", pid, "model", a.model, "mode", a.mode);
                        try { if (branch != null) body.put("branch", branch); if (device != null) body.put("device_id", device); if (title.getText().length() > 0) body.put("title", title.getText().toString().trim()); } catch (Exception ignored) { }
                        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions", body); } }, new MainActivity.Done() { public void ok(Object r2) {
                            JSONObject o = (JSONObject) r2; a.ws.session = o.optJSONObject("session"); a.ws.openThread(o.optJSONObject("thread").optString("id")); } });
                    } }).setNegativeButton("Cancel", null).show();
        } });
    }

    // ================================================================= Sessions (history across Co Approx / Code / Education)
    void history(final String kind, final String view) { history(kind, view, null); }

    void history(final String kind, final String view, final String q) {
        final LinearLayout col = page("Sessions", null, null, null);
        HorizontalScrollView t1 = new HorizontalScrollView(a); t1.setHorizontalScrollBarEnabled(false);
        LinearLayout tabs = a.hbox();
        for (final String[] v : new String[][]{{"recent", "Recent"}, {"active", "Active"}, {"archived", "Archived"}}) {
            TextView c = a.ws.chip(v[1], v[0].equals(view));
            c.setOnClickListener(new View.OnClickListener() { public void onClick(View x) { history(kind, v[0], q); } });
            tabs.addView(c);
        }
        t1.addView(tabs);
        col.addView(t1);
        final EditText search = a.input("Search sessions and messages", InputType.TYPE_CLASS_TEXT);
        if (q != null) search.setText(q);
        search.setOnEditorActionListener(new TextView.OnEditorActionListener() { public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) { history(kind, view, search.getText().toString()); return true; } });
        a.add(col, search, 10);
        HorizontalScrollView t2 = new HorizontalScrollView(a); t2.setHorizontalScrollBarEnabled(false);
        LinearLayout ws = a.hbox();
        for (final String[] k : new String[][]{{"", "All"}, {"work", "Approx Work"}, {"code", "Approx Code"}, {"education", "Education"}}) {
            TextView c = a.ws.chip(k[1], k[0].equals(kind == null ? "" : kind));
            c.setOnClickListener(new View.OnClickListener() { public void onClick(View x) { history(k[0].length() == 0 ? null : k[0], view, search.getText().toString()); } });
            ws.addView(c);
        }
        t2.addView(ws);
        a.add(col, t2, 8);
        final LinearLayout list = a.vbox();
        col.addView(list);
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            return a.api.get("/api/session-history?view=" + view + (kind != null ? "&workspace=" + kind : "") + (q != null && q.length() > 0 ? "&q=" + Api.enc(q) : ""));
        } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            if (ss.length() == 0) list.addView(muted("archived".equals(view) ? "No archived sessions" : "No sessions yet"));
            for (int i = 0; i < ss.length(); i++) list.addView(sessionRow(ss.optJSONObject(i)));
            a.add(list, a.link("Conversations (chat history)", new Runnable() { public void run() { a.showHistory(); } }), 16);
        } });
    }

    // ================================================================= Scheduled
    void scheduled() {
        final LinearLayout col = page("Scheduled", null, null, null);
        final LinearLayout list = a.vbox();
        col.addView(list);
        fab("New task", new Runnable() { public void run() { newScheduled(); } });
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/scheduled"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ts = ((JSONObject) r).optJSONArray("tasks");
            if (ts.length() == 0) {
                LinearLayout e = a.vbox();
                e.setGravity(Gravity.CENTER_HORIZONTAL);
                e.setPadding(0, dp(90), 0, 0);
                TextView t = a.text("No scheduled tasks yet", 19, MainActivity.TEXT, true); t.setGravity(Gravity.CENTER);
                e.addView(t);
                TextView s = a.text("Scheduled tasks run automatically on their configured schedule.", 14, MainActivity.MUTED, false); s.setGravity(Gravity.CENTER);
                a.add(e, s, 8);
                list.addView(e);
                return;
            }
            for (int i = 0; i < ts.length(); i++) {
                final JSONObject t = ts.optJSONObject(i);
                String when = t.optBoolean("enabled") && t.optLong("next_run_at") > 0 ? "next " + DateUtils.formatDateTime(a, t.optLong("next_run_at"), DateUtils.FORMAT_SHOW_DATE | DateUtils.FORMAT_SHOW_TIME | DateUtils.FORMAT_ABBREV_MONTH) : "paused";
                JSONObject last = t.optJSONObject("last_run");
                list.addView(row(t.optString("name"), MainActivity.cap(t.optString("frequency")) + " · " + when + (last != null ? " · last run " + last.optString("status") : ""),
                        t.optBoolean("enabled") ? "enabled" : "off", new Runnable() { public void run() { scheduledDetail(t); } }, null));
            }
        } });
    }

    void newScheduled() {
        LinearLayout box = a.vbox();
        final EditText name = a.input("Task name", InputType.TYPE_CLASS_TEXT);
        final EditText ins = a.input("Instructions (what Approx should do each time)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        ins.setMinLines(3);
        box.addView(name); a.add(box, ins, 8);
        a.add(box, a.text("Frequency", 13, MainActivity.MUTED, true), 12);
        final String[] freqs = {"once", "hourly", "daily", "weekdays", "weekly"};
        final RadioGroup fg = new RadioGroup(a);
        for (int i = 0; i < freqs.length; i++) { RadioButton rb = new RadioButton(a); rb.setText(MainActivity.cap(freqs[i])); rb.setId(2000 + i); fg.addView(rb); }
        fg.check(2002);
        box.addView(fg);
        final java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.add(java.util.Calendar.HOUR_OF_DAY, 1); cal.set(java.util.Calendar.MINUTE, 0);
        final TextView when = a.text("", 15, MainActivity.TEXT, true);
        final Runnable showWhen = new Runnable() { public void run() { when.setText("Starts " + String.format(java.util.Locale.US, "%04d-%02d-%02d %02d:%02d", cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH) + 1, cal.get(java.util.Calendar.DAY_OF_MONTH), cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE)) + "  (tap to change)"); } };
        showWhen.run();
        when.setPadding(0, dp(10), 0, dp(6));
        when.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
            new android.app.DatePickerDialog(a, new android.app.DatePickerDialog.OnDateSetListener() { public void onDateSet(android.widget.DatePicker p, int y, int m, int d) {
                cal.set(y, m, d);
                new android.app.TimePickerDialog(a, new android.app.TimePickerDialog.OnTimeSetListener() { public void onTimeSet(android.widget.TimePicker t, int h, int mi) {
                    cal.set(java.util.Calendar.HOUR_OF_DAY, h); cal.set(java.util.Calendar.MINUTE, mi); showWhen.run(); } }, cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE), true).show();
            } }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH)).show();
        } });
        a.add(box, when, 6);
        final EditText tz = a.input("Time zone", InputType.TYPE_CLASS_TEXT);
        tz.setText(java.util.TimeZone.getDefault().getID());
        a.add(box, tz, 4);
        a.add(box, a.text("Workspace", 13, MainActivity.MUTED, true), 12);
        final String[] wsv = {"work", "code", "education"};
        final RadioGroup wg = new RadioGroup(a);
        for (int i = 0; i < wsv.length; i++) { RadioButton rb = new RadioButton(a); rb.setText(Workspaces.title(wsv[i])); rb.setId(3000 + i); wg.addView(rb); }
        wg.check(3000);
        box.addView(wg);
        a.add(box, a.text("Tools", 13, MainActivity.MUTED, true), 12);
        final String[][] tools = {{"session_files", "Session files"}, {"research_urls", "Research (URL sources)"}, {"artifacts", "Artifacts"}, {"code_repository", "Code repository"}};
        final List<CheckBox> checks = new ArrayList<>();
        for (String[] t : tools) { CheckBox c = new CheckBox(a); c.setText(t[1]); c.setTag(t[0]); checks.add(c); box.addView(c); }
        final Switch en = new Switch(a); en.setText("Enabled"); en.setChecked(true); en.setPadding(0, dp(8), 0, dp(8));
        box.addView(en);
        a.add(box, a.text("Connected services: none are configured on this server yet, so tasks can't use Gmail, Drive or similar.", 12, MainActivity.MUTED, false), 6);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Create scheduled task").setView(a.ws.scroll(a.ws.pad(box)))
                .setPositiveButton("Save", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) {
                    JSONArray tl = new JSONArray();
                    for (CheckBox c : checks) if (c.isChecked()) tl.put(c.getTag());
                    final JSONObject b = MainActivity.obj("name", name.getText().toString().trim(), "instructions", ins.getText().toString().trim(),
                            "frequency", freqs[fg.getCheckedRadioButtonId() - 2000], "timezone", tz.getText().toString().trim(),
                            "start_at", String.format(java.util.Locale.US, "%04d-%02d-%02dT%02d:%02d", cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH) + 1, cal.get(java.util.Calendar.DAY_OF_MONTH), cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE)),
                            "workspace", wsv[wg.getCheckedRadioButtonId() - 3000], "enabled", en.isChecked(), "tools", tl);
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/scheduled", b); } }, new MainActivity.Done() { public void ok(Object r) { a.toast("Scheduled task saved"); scheduled(); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void scheduledDetail(final JSONObject t) {
        final LinearLayout col = page(t.optString("name"), "‹", "Back to Scheduled", new Runnable() { public void run() { scheduled(); } });
        col.addView(a.text(t.optString("instructions"), 15, MainActivity.TEXT, false));
        a.add(col, muted(MainActivity.cap(t.optString("frequency")) + " · " + t.optString("timezone") + " · " + Workspaces.title(t.optString("workspace"))), 6);
        Switch en = new Switch(a); en.setText("Enabled"); en.setChecked(t.optBoolean("enabled")); en.setPadding(0, dp(8), 0, dp(8));
        en.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() { public void onCheckedChanged(android.widget.CompoundButton b, boolean v) {
            a.call("PATCH", "/api/scheduled/" + t.optString("id"), MainActivity.obj("enabled", v), new Runnable() { public void run() { a.toast("Saved"); } }); } });
        a.add(col, en, 8);
        a.add(col, a.button("Run now", true, new Runnable() { public void run() {
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/scheduled/" + t.optString("id") + "/run", new JSONObject()).optJSONObject("run"); } },
                    new MainActivity.Done() { public void ok(Object r) { JSONObject o = (JSONObject) r; a.toast("Run " + o.optString("status")); if (o.has("session_id")) a.ws.open(o.optString("session_id"), null); else scheduledDetail(t); } });
        } }), 10);
        a.add(col, header("Runs"), 22);
        final LinearLayout runs = a.vbox();
        col.addView(runs);
        a.add(col, a.button("Delete task", false, new Runnable() { public void run() {
            a.confirm("Delete this scheduled task?", "Its past sessions stay in Approx Work.", new Runnable() { public void run() { a.call("DELETE", "/api/scheduled/" + t.optString("id"), null, new Runnable() { public void run() { scheduled(); } }); } });
        } }), 24);
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/scheduled/" + t.optString("id") + "/runs"); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray rs = ((JSONObject) r).optJSONArray("runs");
            if (rs.length() == 0) runs.addView(muted("No runs yet"));
            for (int i = 0; i < rs.length(); i++) {
                final JSONObject x = rs.optJSONObject(i);
                runs.addView(row(DateUtils.formatDateTime(a, x.optLong("started_at"), DateUtils.FORMAT_SHOW_DATE | DateUtils.FORMAT_SHOW_TIME), x.optString("trigger") + " · " + x.optString("output").replace('\n', ' ').substring(0, Math.min(90, x.optString("output").length())),
                        x.optString("status"), x.isNull("session_id") ? null : new Runnable() { public void run() { a.ws.open(x.optString("session_id"), null); } }, null));
            }
        } });
    }

    // ================================================================= Artifacts
    void artifacts(final String q) {
        final LinearLayout col = page("Artifacts", null, null, null);
        final EditText search = a.input("Search artifacts", InputType.TYPE_CLASS_TEXT);
        if (q != null) search.setText(q);
        search.setOnEditorActionListener(new TextView.OnEditorActionListener() { public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) { artifacts(search.getText().toString()); return true; } });
        col.addView(search);
        final LinearLayout list = a.vbox();
        a.add(col, list, 6);
        fab("Create artifact", new Runnable() { public void run() { createArtifact(); } });
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/artifacts" + (q != null && q.length() > 0 ? "?q=" + Api.enc(q) : "")); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray as = ((JSONObject) r).optJSONArray("artifacts");
            if (as.length() == 0) { list.addView(muted(q != null && q.length() > 0 ? "No artifact matches \"" + q + "\"." : "No artifacts yet")); return; }
            for (int i = 0; i < as.length(); i++) {
                final JSONObject x = as.optJSONObject(i);
                String kind = "quiz".equals(x.optString("language")) ? "quiz" : "flashcards".equals(x.optString("language")) ? "flashcards" : x.optString("kind");
                list.addView(row(x.optString("title"), kind + " · v" + x.optInt("current_version") + (x.isNull("session_title") ? "" : " · " + x.optString("session_title")) + " · " + ago(x.optLong("updated_at")),
                        x.optBoolean("shared") ? "shared" : null, new Runnable() { public void run() { openArtifact(x.optString("id")); } }, null));
            }
        } });
    }

    void createArtifact() {
        LinearLayout box = a.vbox();
        final EditText t = a.input("Title", InputType.TYPE_CLASS_TEXT);
        final EditText c = a.input("Content (Markdown)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        c.setMinLines(6);
        box.addView(t); a.add(box, c, 8);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Create artifact").setView(a.ws.pad(box))
                .setPositiveButton("Save", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) {
                    final JSONObject b = MainActivity.obj("title", t.getText().toString().trim().length() > 0 ? t.getText().toString().trim() : "Untitled", "kind", "markdown", "content", c.getText().toString());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/workspace/artifacts", b).optJSONObject("artifact"); } },
                            new MainActivity.Done() { public void ok(Object r) { openArtifact(((JSONObject) r).optString("id")); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void openArtifact(final String id) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/workspace/artifacts/" + id).optJSONObject("artifact"); } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONObject ar = (JSONObject) r;
            final LinearLayout col = page(ar.optString("title"), "⋮", "Artifact actions", new Runnable() { public void run() { artifactMenu(ar); } });
            a.add(col, muted(ar.optString("kind") + " · version " + ar.optInt("current_version")), 0);
            String lang = ar.optString("language");
            if ("flashcards".equals(lang)) { try { a.ws.showCards(new JSONObject(ar.optString("content"))); } catch (Exception ignored) { } }
            View body = "quiz".equals(lang) ? muted("Quiz — practise it from its Education session (Quiz tool).") : a.assistantBody(ar.optString("content"));
            a.add(col, body, 8);
        } });
    }

    void artifactMenu(final JSONObject ar) {
        final String id = ar.optString("id");
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(ar.optString("title")).setItems(new String[]{"Edit", "Rename", "Share link", "Stop sharing", "Delete"}, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface x, int w) {
                if (w == 0) a.ws.editArtifact(ar);
                else if (w == 1) {
                    final EditText e = a.input("Title", InputType.TYPE_CLASS_TEXT); e.setText(ar.optString("title"));
                    new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Rename").setView(a.ws.pad(e)).setPositiveButton("Save", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface y, int z) { a.call("PATCH", "/api/artifacts/" + id, MainActivity.obj("title", e.getText().toString()), new Runnable() { public void run() { openArtifact(id); } }); } })
                            .setNegativeButton("Cancel", null).show();
                } else if (w == 2) {
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/artifacts/" + id + "/share", new JSONObject()); } }, new MainActivity.Done() { public void ok(Object r) {
                        Intent send = new Intent(Intent.ACTION_SEND); send.setType("text/plain");
                        send.putExtra(Intent.EXTRA_TEXT, ar.optString("title") + "\n" + ((JSONObject) r).optString("url"));
                        a.startActivity(Intent.createChooser(send, "Share artifact link"));
                    } });
                } else if (w == 3) a.call("DELETE", "/api/artifacts/" + id + "/share", null, new Runnable() { public void run() { a.toast("Link turned off"); } });
                else a.confirm("Delete artifact?", "All versions are deleted.", new Runnable() { public void run() { a.call("DELETE", "/api/workspace/artifacts/" + id, null, new Runnable() { public void run() { a.toast("Deleted"); artifacts(null); } }); } });
            } }).show();
    }

    // ================================================================= Co Approx: run a task in a session (continues if you leave)
    void runTask() {
        final EditText ins = a.input("What should Approx Work do?", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        ins.setMinLines(3);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Run a task").setView(a.ws.pad(ins))
                .setMessage("The task runs on the Approx server in this session. You can leave — the result stays in the session and you get a notification.")
                .setPositiveButton("Run", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) {
                    final String sid = a.ws.session.optString("id");
                    final JSONObject b = MainActivity.obj("instruction", ins.getText().toString().trim());
                    a.toast("Running… you can leave this screen");
                    a.pool.execute(new Runnable() { public void run() {
                        try {
                            final JSONObject r = a.api.post("/api/work-sessions/" + sid + "/run", b);
                            a.ui.post(new Runnable() { public void run() {
                                if (a.ws.session != null && sid.equals(a.ws.session.optString("id"))) a.ws.open(sid, r.optJSONObject("agent_run").optString("thread_id"));
                                else a.toast("Approx Work task finished — open it from Recents");
                            } });
                        } catch (final Exception e) { a.ui.post(new Runnable() { public void run() { a.handleError(e); } }); }
                    } });
                } }).setNegativeButton("Cancel", null).show();
    }
}
