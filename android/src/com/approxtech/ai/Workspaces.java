package com.approxtech.ai;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.InputType;
import android.text.format.DateUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Approx Work · Approx Code · Approx Education on Android — one session architecture (API 1.9):
 * workspace → project → session (server-side ID) → threads (each a full conversation) → tasks · files · outputs · logs.
 * Everything shown here comes from the backend; "New session" always creates a new server session.
 */
final class Workspaces {
    private final MainActivity a;
    /** The session whose thread is open (null outside sessions). */
    JSONObject session;
    Workspaces(MainActivity a) { this.a = a; }

    static final String[] KINDS = {"work", "code", "education"};
    static String title(String k) { return "work".equals(k) ? "Approx Work" : "code".equals(k) ? "Approx Code" : "education".equals(k) ? "Education" : "Approx"; }
    static String glyph(String k) { return "work".equals(k) ? "▦" : "code".equals(k) ? "</>" : "📘"; }
    static String newLabel(String k) { return "work".equals(k) ? "New session" : "code".equals(k) ? "New coding session" : "New study session"; }
    static String projectLabel(String k) { return "work".equals(k) ? "Projects" : "code".equals(k) ? "Repositories" : "Courses & subjects"; }

    int dp(int v) { return (int) (v * a.getResources().getDisplayMetrics().density); }

    // ================================================================= workspace home
    void home(final String kind) {
        a.workspace = kind; a.chatId = null; a.projectId = null; a.attachments.clear(); session = null;
        final LinearLayout col = a.vbox();
        col.setPadding(dp(16), dp(18), dp(16), dp(28));
        LinearLayout head = a.hbox();
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView ic = a.text(glyph(kind), 18, MainActivity.GREEN_TEXT, true);
        ic.setGravity(Gravity.CENTER);
        ic.setBackground(a.bgShape(MainActivity.GREEN_SOFT, 12, Color.TRANSPARENT));
        head.addView(ic, new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(0, -2, 1); hl.leftMargin = dp(12);
        head.addView(a.text(title(kind), 22, MainActivity.TEXT, true), hl);
        col.addView(head);
        a.add(col, a.button("＋  " + newLabel(kind), true, new Runnable() { public void run() { newSession(kind, null); } }), 16);
        final EditText search = a.input("Search sessions", InputType.TYPE_CLASS_TEXT);
        a.add(col, search, 10);
        final LinearLayout results = a.vbox();
        a.add(col, results, 0);
        search.setOnEditorActionListener(new TextView.OnEditorActionListener() { public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) {
            searchInto(kind, search.getText().toString(), results); return true; } });
        final LinearLayout body = a.vbox();
        a.add(col, body, 8);
        ScrollView sv = new ScrollView(a);
        sv.addView(col);
        a.shell(sv, false);
        if (a.titleView != null) a.titleView.setText(title(kind));
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/workspaces/" + kind); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONObject o = (JSONObject) r;
            renderOverview(kind, o, body);
        } });
    }

    void renderOverview(final String kind, JSONObject o, LinearLayout body) {
        body.removeAllViews();
        if ("education".equals(kind) && o.optJSONObject("progress") != null) {
            JSONObject p = o.optJSONObject("progress");
            section(body, "Progress");
            String avg = p.isNull("average_percent") ? "no quizzes yet" : p.optInt("average_percent") + "% average";
            body.addView(card(p.optInt("quiz_attempts") + " quiz attempts · " + avg, null, null));
            JSONArray bc = p.optJSONArray("by_course");
            for (int i = 0; bc != null && i < bc.length(); i++) {
                JSONObject c = bc.optJSONObject(i);
                body.addView(card(c.optString("name"), c.optInt("quiz_attempts") + " quizzes · " + (c.isNull("average_percent") ? "–" : c.optInt("average_percent") + "%")
                        + " · assignments " + c.optInt("assignments_done") + "/" + c.optInt("assignments_total"), null));
            }
        }
        section(body, "Recent sessions");
        JSONArray ss = o.optJSONArray("sessions");
        if (ss == null || ss.length() == 0) body.addView(muted("No sessions yet. Start one above — each session keeps its own context."));
        for (int i = 0; ss != null && i < ss.length(); i++) body.addView(sessionRow(ss.optJSONObject(i)));
        body.addView(a.link("Session history", new Runnable() { public void run() { a.hub.history(kind, "recent"); } }));
        if ("work".equals(kind)) {
            final LinearLayout sched = sectionWithLoad(body, "Scheduled tasks", "＋ New", new Runnable() { public void run() { a.hub.newScheduled(); } });
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/scheduled"); } }, new MainActivity.Done() { public void ok(Object r) {
                JSONArray ts = ((JSONObject) r).optJSONArray("tasks");
                int n = 0;
                for (int i = 0; i < ts.length(); i++) {
                    final JSONObject t = ts.optJSONObject(i);
                    if (!"work".equals(t.optString("workspace"))) continue;
                    n++;
                    sched.addView(card("⏱ " + t.optString("name"), MainActivity.cap(t.optString("frequency")) + (t.optBoolean("enabled") ? "" : " · paused"), new Runnable() { public void run() { a.hub.scheduledDetail(t); } }));
                }
                if (n == 0) sched.addView(muted("No scheduled tasks yet."));
            } });
        }
        if ("education".equals(kind)) {
            final LinearLayout quizzes = sectionWithLoad(body, "Quizzes & practice", null, null);
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/artifacts"); } }, new MainActivity.Done() { public void ok(Object r) {
                JSONArray as = ((JSONObject) r).optJSONArray("artifacts");
                int n = 0;
                for (int i = 0; i < as.length(); i++) {
                    final JSONObject x = as.optJSONObject(i);
                    if (!"quiz".equals(x.optString("language")) || x.isNull("session_id")) continue;
                    n++;
                    quizzes.addView(card("📝 " + x.optString("title"), (x.isNull("session_title") ? "" : x.optString("session_title") + " · ") + "tap to practise", new Runnable() { public void run() { practise(x.optString("session_id"), x.optString("id")); } }));
                }
                if (n == 0) quizzes.addView(muted("Quizzes you create in a study session appear here for practice."));
            } });
        }

        LinearLayout ph = sectionWithAction(body, projectLabel(kind), "＋ New", new Runnable() { public void run() { newProject(kind, null); } });
        JSONArray ps = o.optJSONArray("projects");
        if (ps == null || ps.length() == 0) body.addView(muted("code".equals(kind) ? "No repositories yet." : "education".equals(kind) ? "No courses yet — add a subject or course to group study sessions." : "No projects yet."));
        for (int i = 0; ps != null && i < ps.length(); i++) {
            final JSONObject p = ps.optJSONObject(i);
            body.addView(card(p.optString("name"), p.optInt("session_count") + " sessions", new Runnable() { public void run() { projectScreen(kind, p); } }));
        }
        section(body, "education".equals(kind) ? "Assignments & tasks" : "Active tasks");
        JSONArray ts = o.optJSONArray("active_tasks");
        if (ts == null || ts.length() == 0) body.addView(muted("Nothing open."));
        for (int i = 0; ts != null && i < ts.length(); i++) {
            final JSONObject t = ts.optJSONObject(i);
            body.addView(card(("assignment".equals(t.optString("kind")) ? "📝 " : "☐ ") + t.optString("title"), t.optString("status").replace('_', ' '),
                    new Runnable() { public void run() { open(t.optString("session_id"), t.optString("thread_id", null)); } }));
        }
        section(body, "education".equals(kind) ? "Documents & notes" : "Files");
        JSONArray fs = o.optJSONArray("files");
        if (fs == null || fs.length() == 0) body.addView(muted("Files you add to a session appear here."));
        for (int i = 0; fs != null && i < fs.length(); i++) {
            final JSONObject f = fs.optJSONObject(i);
            body.addView(card(f.optString("filename"), f.optString("kind"), new Runnable() { public void run() { open(f.optString("session_id"), null); } }));
        }
        section(body, "Outputs");
        JSONArray as = o.optJSONArray("artifacts");
        if (as == null || as.length() == 0) body.addView(muted("Documents, quizzes and other outputs of your sessions appear here."));
        for (int i = 0; as != null && i < as.length(); i++) {
            final JSONObject ar = as.optJSONObject(i);
            body.addView(card(ar.optString("title"), ar.optString("kind"), new Runnable() { public void run() { showArtifact(ar.optString("id")); } }));
        }
        section(body, "Connected apps");
        JSONArray cs = o.optJSONArray("connectors");
        for (int i = 0; cs != null && i < cs.length(); i++) {
            JSONObject c = cs.optJSONObject(i);
            body.addView(card(c.optString("name"), "connected".equals(c.optString("status")) ? "Connected" : "Not configured on this server", null));
        }
    }

    void searchInto(final String kind, final String q, final LinearLayout out) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/work-sessions?workspace=" + kind + "&q=" + Api.enc(q)); } }, new MainActivity.Done() { public void ok(Object r) {
            out.removeAllViews();
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            if (q.trim().length() == 0) return;
            section(out, "Results");
            if (ss.length() == 0) out.addView(muted("No session matches \"" + q + "\"."));
            for (int i = 0; i < ss.length(); i++) out.addView(sessionRow(ss.optJSONObject(i)));
        } });
    }

    /** All sessions (or one workspace's), active or archived — the "Sessions" destination of the menu. */
    void sessionsScreen(final String kind, final String status) {
        final LinearLayout col = a.vbox();
        col.setPadding(dp(16), dp(16), dp(16), dp(24));
        col.addView(a.text(kind == null ? "Sessions" : title(kind) + " · " + ("archived".equals(status) ? "archived" : "sessions"), 20, MainActivity.TEXT, true));
        final LinearLayout list = a.vbox();
        a.add(col, list, 10);
        ScrollView sv = new ScrollView(a); sv.addView(col);
        a.shell(sv, false);
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            return a.api.get("/api/work-sessions?status=" + status + (kind == null ? "" : "&workspace=" + kind)); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            if (ss.length() == 0) list.addView(muted("No sessions."));
            for (int i = 0; i < ss.length(); i++) list.addView(sessionRow(ss.optJSONObject(i)));
            if (!"archived".equals(status)) list.addView(a.link("Archived sessions", new Runnable() { public void run() { sessionsScreen(kind, "archived"); } }));
        } });
    }

    void projectScreen(final String kind, final JSONObject p) {
        final LinearLayout col = a.vbox();
        col.setPadding(dp(16), dp(16), dp(16), dp(24));
        col.addView(a.text(p.optString("name"), 20, MainActivity.TEXT, true));
        if (p.optString("description").length() > 0) a.add(col, muted(p.optString("description")), 4);
        a.add(col, a.button("＋  " + newLabel(kind), true, new Runnable() { public void run() { newSession(kind, p.optString("id")); } }), 14);
        final LinearLayout list = a.vbox();
        a.add(col, list, 10);
        ScrollView sv = new ScrollView(a); sv.addView(col);
        a.shell(sv, false);
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/work-sessions?workspace=" + kind + "&project_id=" + p.optString("id")); } }, new MainActivity.Done() { public void ok(Object r) {
            JSONArray ss = ((JSONObject) r).optJSONArray("sessions");
            section(list, "Sessions in this " + ("education".equals(kind) ? "course" : "code".equals(kind) ? "repository" : "project"));
            if (ss.length() == 0) list.addView(muted("No sessions yet."));
            for (int i = 0; i < ss.length(); i++) list.addView(sessionRow(ss.optJSONObject(i)));
        } });
    }

    /** Projects across the three workspaces — the "Projects" destination of the menu. */
    void projectsScreen() {
        final LinearLayout col = a.vbox();
        col.setPadding(dp(16), dp(16), dp(16), dp(24));
        col.addView(a.text("Projects", 20, MainActivity.TEXT, true));
        final LinearLayout list = a.vbox();
        a.add(col, list, 6);
        ScrollView sv = new ScrollView(a); sv.addView(col);
        a.shell(sv, false);
        for (final String k : KINDS) {
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/workspaces/" + k); } }, new MainActivity.Done() { public void ok(Object r) {
                LinearLayout box = a.vbox();
                sectionWithAction(box, title(k) + " · " + projectLabel(k), "＋ New", new Runnable() { public void run() { newProject(k, null); } });
                JSONArray ps = ((JSONObject) r).optJSONArray("projects");
                if (ps.length() == 0) box.addView(muted("None yet."));
                for (int i = 0; i < ps.length(); i++) {
                    final JSONObject p = ps.optJSONObject(i);
                    box.addView(card(p.optString("name"), p.optInt("session_count") + " sessions", new Runnable() { public void run() { projectScreen(k, p); } }));
                }
                list.addView(box);
            } });
        }
    }

    // ================================================================= create / open
    void newProject(final String kind, final Runnable after) {
        final EditText name = a.input("code".equals(kind) ? "Repository name" : "education".equals(kind) ? "Course or subject (e.g. Class 11 Computer Science)" : "Project name", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("New " + ("code".equals(kind) ? "repository" : "education".equals(kind) ? "course" : "project")).setView(pad(name))
                .setPositiveButton("Create", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final String n = name.getText().toString().trim();
                    if (n.length() == 0) return;
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/workspaces/" + kind + "/projects", MainActivity.obj("name", n)); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast("Created " + n); if (after != null) after.run(); else home(kind); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    /** New Session: always a new server-side session (new ID) with its own first thread. */
    void newSession(final String kind, final String presetProject) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/workspaces/" + kind); } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONArray ps = ((JSONObject) r).optJSONArray("projects");
            LinearLayout box = a.vbox();
            final EditText title = a.input("education".equals(kind) ? "Session title (e.g. Class 11 CS — Chapter 4)" : "Session title (optional)", InputType.TYPE_CLASS_TEXT);
            box.addView(title);
            final List<String> ids = new ArrayList<>();
            final RadioGroup rg = new RadioGroup(a);
            if (!"code".equals(kind)) { RadioButton none = new RadioButton(a); none.setText("No " + ("education".equals(kind) ? "course" : "project")); none.setId(View.generateViewId()); rg.addView(none); ids.add(null); none.setChecked(presetProject == null); }
            for (int i = 0; i < ps.length(); i++) {
                RadioButton rb = new RadioButton(a);
                rb.setText(ps.optJSONObject(i).optString("name"));
                rb.setId(View.generateViewId());
                rg.addView(rb);
                ids.add(ps.optJSONObject(i).optString("id"));
                if (ps.optJSONObject(i).optString("id").equals(presetProject) || ("code".equals(kind) && presetProject == null && i == 0)) rb.setChecked(true);
            }
            if (ps.length() > 0 || !"code".equals(kind)) { a.add(box, a.text(projectLabel(kind), 13, MainActivity.MUTED, true), 12); box.addView(rg); }
            if ("code".equals(kind) && ps.length() == 0) { a.add(box, muted("A coding session needs a repository. Create one first."), 12); }
            AlertDialog.Builder b = new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(newLabel(kind)).setView(pad(box))
                    .setNegativeButton("Cancel", null);
            if ("code".equals(kind) && ps.length() == 0) b.setPositiveButton("New repository", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                newProject(kind, new Runnable() { public void run() { newSession(kind, null); } }); } });
            else b.setPositiveButton("Start session", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                String pid = null;
                for (int i = 0; i < rg.getChildCount(); i++) if (((RadioButton) rg.getChildAt(i)).isChecked()) pid = ids.get(i);
                create(kind, pid, title.getText().toString().trim(), null);
            } });
            if ("education".equals(kind)) b.setNeutralButton("Start from a PDF", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) { a.startSession("education"); } });
            b.show();
        } });
    }

    void create(final String kind, final String projectId, final String title, final String fileId) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject b = MainActivity.obj("workspace", kind, "model", a.model, "mode", a.mode);
            if (projectId != null) b.put("project_id", projectId);
            if (title != null && title.length() > 0) b.put("title", title);
            if (fileId != null) b.put("file_id", fileId);
            return a.api.post("/api/work-sessions", b);
        } }, new MainActivity.Done() { public void ok(Object r) {
            JSONObject o = (JSONObject) r;
            session = o.optJSONObject("session");
            openThread(o.optJSONObject("thread").optString("id"));
        } });
    }

    /** Resume a session exactly where it was: its threads, tasks and files come from the server. */
    void open(final String sessionId, final String threadId) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/work-sessions/" + sessionId).optJSONObject("session"); } }, new MainActivity.Done() { public void ok(Object r) {
            session = (JSONObject) r;
            JSONArray th = session.optJSONArray("threads");
            String t = threadId != null && threadId.length() > 0 && !"null".equals(threadId) ? threadId : th.length() > 0 ? th.optJSONObject(th.length() - 1).optString("id") : null;
            if (t == null) { newThread(); return; }
            openThread(t);
        } });
    }

    void openThread(String threadId) {
        a.workspace = session.optString("kind");
        a.projectId = session.isNull("project") ? null : session.optJSONObject("project").optString("id");
        a.attachments.clear();
        a.showChat(threadId);
    }

    void refreshAndOpen(final String threadId) { open(session.optString("id"), threadId); }

    void newThread() {
        final EditText t = a.input("Thread title (e.g. Research, Draft, Bug #12)", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("New thread").setView(pad(t))
                .setMessage("A thread is a separate conversation inside this session. It starts with the session's context, not other threads' messages.")
                .setPositiveButton("Create", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final String title = t.getText().toString().trim();
                    a.bg(new MainActivity.Job() { public Object run() throws Exception {
                        return a.api.post("/api/work-sessions/" + session.optString("id") + "/threads", MainActivity.obj("title", title.length() > 0 ? title : "New thread")).optJSONObject("thread");
                    } }, new MainActivity.Done() { public void ok(Object r) { refreshAndOpen(((JSONObject) r).optString("id")); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    // ================================================================= session bar (shown above a session thread)
    /** Threads as chips + the session's tools. Inserted into the chat page when the open chat belongs to a session. */
    View sessionBar(final String threadId) {
        final String kind = session.optString("kind");
        LinearLayout bar = a.vbox();
        bar.setPadding(dp(10), dp(6), dp(10), dp(6));
        bar.setBackgroundColor(MainActivity.SURFACE);
        LinearLayout r1 = a.hbox();
        r1.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = a.text(session.optString("title"), 14, MainActivity.TEXT, true);
        name.setSingleLine(true);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        r1.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        TextView menu = chip("Session ▾", false);
        menu.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { sessionMenu(); } });
        r1.addView(menu);
        bar.addView(r1);
        HorizontalScrollView hs = new HorizontalScrollView(a);
        hs.setHorizontalScrollBarEnabled(false);
        LinearLayout chips = a.hbox();
        JSONArray th = session.optJSONArray("threads");
        for (int i = 0; th != null && i < th.length(); i++) {
            final JSONObject t = th.optJSONObject(i);
            TextView c = chip(t.optString("title"), t.optString("id").equals(threadId));
            c.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { if (!a.streaming) openThread(t.optString("id")); } });
            chips.addView(c);
        }
        TextView plus = chip("＋ Thread", false);
        plus.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { newThread(); } });
        chips.addView(plus);
        hs.addView(chips);
        a.add(bar, hs, 6);
        HorizontalScrollView hs2 = new HorizontalScrollView(a);
        hs2.setHorizontalScrollBarEnabled(false);
        LinearLayout tools = a.hbox();
        String[] names = "code".equals(kind) ? new String[]{"Agent", "Files", "Changes", "Commit", "Branch", "Run / Test", "Tasks", "Logs"}
                : "education".equals(kind) ? new String[]{"Documents", "Quiz", "Flashcards", "Study plan", "Assignments", "Notes", "Progress"}
                : new String[]{"Run task", "Tasks", "Plan", "Files", "Outputs", "Logs"};
        for (final String n : names) {
            TextView t = chip(n, false);
            t.setTextColor(MainActivity.GREEN_TEXT);
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { tool(n); } });
            tools.addView(t);
        }
        hs2.addView(tools);
        a.add(bar, hs2, 6);
        return bar;
    }

    TextView chip(String label, boolean on) {
        TextView t = a.text(label, 13, on ? MainActivity.ON_GREEN : MainActivity.TEXT, on);
        t.setSingleLine(true);
        t.setPadding(dp(12), dp(6), dp(12), dp(6));
        t.setBackground(on ? a.bgShape(MainActivity.GREEN, 999, MainActivity.GREEN) : a.pressable(a.bgShape(MainActivity.BG, 999, MainActivity.LINE), a.bgShape(MainActivity.SURFACE3, 999, MainActivity.LINE)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2); lp.rightMargin = dp(6);
        t.setLayoutParams(lp);
        return t;
    }

    void sessionMenu() {
        final String sid = session.optString("id");
        final String[] items = {"Rename", "Session notes (shared by its threads)", "Duplicate", "archived".equals(session.optString("status")) ? "Unarchive" : "Archive", "Delete", "All sessions"};
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(session.optString("title")).setItems(items, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface d, int w) {
                if (w == 0 || w == 1) {
                    final EditText e = a.input(w == 0 ? "Title" : "Notes, goals or constraints for this session", w == 0 ? InputType.TYPE_CLASS_TEXT : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
                    e.setText(w == 0 ? session.optString("title") : session.optString("context"));
                    final String key = w == 0 ? "title" : "context";
                    new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(items[w]).setView(pad(e)).setPositiveButton("Save", new DialogInterface.OnClickListener() {
                        public void onClick(DialogInterface d2, int x) { patch(MainActivity.obj(key, e.getText().toString())); } }).setNegativeButton("Cancel", null).show();
                } else if (w == 2) {
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid + "/duplicate", new JSONObject()).optJSONObject("session"); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast("Duplicated as a new session"); session = (JSONObject) r; open(session.optString("id"), null); } });
                } else if (w == 3) {
                    patch(MainActivity.obj("status", "archived".equals(session.optString("status")) ? "active" : "archived"));
                } else if (w == 4) {
                    a.confirm("Delete session?", "Its threads and messages are deleted. Files stay in Files.", new Runnable() { public void run() {
                        final String kind = session.optString("kind");
                        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("DELETE", "/api/work-sessions/" + sid, null); } },
                                new MainActivity.Done() { public void ok(Object r) { a.toast("Session deleted"); home(kind); } });
                    } });
                } else home(session.optString("kind"));
            } }).show();
    }

    void patch(final JSONObject body) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("PATCH", "/api/work-sessions/" + session.optString("id"), body).optJSONObject("session"); } },
                new MainActivity.Done() { public void ok(Object r) { session = (JSONObject) r; a.toast("Saved"); openThread(a.chatId); } });
    }

    // ================================================================= tools
    void tool(String n) {
        if ("Tasks".equals(n)) tasks("task");
        else if ("Assignments".equals(n)) tasks("assignment");
        else if ("Plan".equals(n)) plan();
        else if ("Files".equals(n) && "code".equals(session.optString("kind"))) repoFiles();
        else if ("Files".equals(n) || "Documents".equals(n)) files();
        else if ("Outputs".equals(n) || "Notes".equals(n)) outputs("Notes".equals(n));
        else if ("Logs".equals(n)) logs();
        else if ("Changes".equals(n)) changes();
        else if ("Commit".equals(n)) commit();
        else if ("Branch".equals(n)) branches();
        else if ("Run / Test".equals(n)) runner();
        else if ("Quiz".equals(n)) quiz();
        else if ("Agent".equals(n)) agent();
        else if ("Run task".equals(n)) a.hub.runTask();
        else if ("Flashcards".equals(n)) flashcards();
        else if ("Study plan".equals(n)) studyPlan();
        else if ("Progress".equals(n)) home("education");
    }

    AlertDialog panel(String title, View content) {
        ScrollView sv = new ScrollView(a);
        sv.addView(content);
        return new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(title).setView(sv).setPositiveButton("Close", null).show();
    }
    String sid() { return session.optString("id"); }
    String pid() { return session.isNull("project") ? null : session.optJSONObject("project").optString("id"); }

    void tasks(final String kind) {
        final LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        final AlertDialog[] dlg = new AlertDialog[1];
        final EditText t = a.input("assignment".equals(kind) ? "New assignment (e.g. Exercise 4.2)" : "New task", InputType.TYPE_CLASS_TEXT);
        box.addView(t);
        a.add(box, a.button("Add", false, new Runnable() { public void run() {
            final String title = t.getText().toString().trim();
            if (title.length() == 0) return;
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/tasks", MainActivity.obj("title", title, "kind", kind)); } },
                    new MainActivity.Done() { public void ok(Object r) { dlg[0].dismiss(); refreshThen(new Runnable() { public void run() { tasks(kind); } }); } });
        } }), 6);
        JSONArray ts = session.optJSONArray("tasks");
        int shown = 0;
        for (int i = 0; ts != null && i < ts.length(); i++) {
            final JSONObject x = ts.optJSONObject(i);
            if (!kind.equals(x.optString("kind")) && !("task".equals(kind) && "assignment".equals(x.optString("kind")))) continue;
            shown++;
            final boolean done = "done".equals(x.optString("status"));
            LinearLayout row = a.hbox();
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(10), 0, dp(10));
            TextView box2 = a.text(done ? "☑" : "☐", 20, MainActivity.GREEN_TEXT, false);
            box2.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("PATCH", "/api/tasks/" + x.optString("id"), MainActivity.obj("status", done ? "todo" : "done")); } },
                        new MainActivity.Done() { public void ok(Object r) { dlg[0].dismiss(); refreshThen(new Runnable() { public void run() { tasks(kind); } }); } });
            } });
            row.addView(box2);
            LinearLayout tx = a.vbox();
            tx.addView(a.text(x.optString("title"), 15, MainActivity.TEXT, false));
            String due = x.isNull("due_at") ? "" : " · due " + DateUtils.formatDateTime(a, x.optLong("due_at"), DateUtils.FORMAT_SHOW_DATE | DateUtils.FORMAT_ABBREV_MONTH);
            tx.addView(a.text(x.optString("status").replace('_', ' ') + due + (x.optBoolean("overdue") ? " · OVERDUE" : "") + ("agent".equals(x.optString("created_by")) ? " · planned by Approx" : "")
                    + (x.isNull("thread_id") ? "" : " · has its own thread"), 12, x.optBoolean("overdue") ? MainActivity.DANGER : MainActivity.MUTED, false));
            tx.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) { dlg[0].dismiss(); setDue(x, kind); return true; } });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1); lp.leftMargin = dp(10);
            row.addView(tx, lp);
            if (!x.isNull("thread_id")) {
                TextView go = a.text("Open ›", 13, MainActivity.GREEN_TEXT, true);
                go.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { dlg[0].dismiss(); openThread(x.optString("thread_id")); } });
                row.addView(go);
            }
            box.addView(row);
        }
        if (shown == 0) a.add(box, muted("Nothing here yet."), 8);
        else a.add(box, muted("Long-press a task to set or clear its due date."), 8);
        dlg[0] = panel("assignment".equals(kind) ? "Assignments" : "Tasks", box);
    }

    void setDue(final JSONObject t, final String kind) {
        final java.util.Calendar c = java.util.Calendar.getInstance();
        if (!t.isNull("due_at")) c.setTimeInMillis(t.optLong("due_at"));
        android.app.DatePickerDialog d = new android.app.DatePickerDialog(a, new android.app.DatePickerDialog.OnDateSetListener() {
            public void onDateSet(android.widget.DatePicker v, int y, int m, int day) {
                java.util.Calendar due = java.util.Calendar.getInstance(); due.set(y, m, day, 23, 59, 0);
                saveDue(t, due.getTimeInMillis(), kind);
            } }, c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH), c.get(java.util.Calendar.DAY_OF_MONTH));
        d.setButton(DialogInterface.BUTTON_NEUTRAL, "No due date", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) { saveDue(t, -1, kind); } });
        d.show();
    }
    void saveDue(final JSONObject t, final long due, final String kind) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject b = new JSONObject(); b.put("due_at", due < 0 ? JSONObject.NULL : (Object) due);
            return a.api.request("PATCH", "/api/tasks/" + t.optString("id"), b);
        } }, new MainActivity.Done() { public void ok(Object r) { a.toast(due < 0 ? "Due date cleared" : "Due date saved"); refreshThen(new Runnable() { public void run() { tasks(kind); } }); } });
    }

    void refreshThen(final Runnable then) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/work-sessions/" + sid()).optJSONObject("session"); } },
                new MainActivity.Done() { public void ok(Object r) { session = (JSONObject) r; then.run(); } });
    }

    void plan() {
        final EditText g = a.input("Goal (e.g. Prepare the Q3 board report)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Plan with Approx").setView(pad(g))
                .setMessage("Approx breaks the goal into tasks. Each task gets its own thread in this session.")
                .setPositiveButton("Plan", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final String goal = g.getText().toString().trim();
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/plan", MainActivity.obj("goal", goal)); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast(((JSONObject) r).optJSONArray("tasks").length() + " tasks planned"); refreshAndOpen(a.chatId); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void files() {
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        final AlertDialog[] dlg = new AlertDialog[1];
        a.add(box, a.button("＋ Add a file to this session", false, new Runnable() { public void run() { dlg[0].dismiss(); a.pickForSession(sid()); } }), 4);
        a.add(box, muted("Files of a session are read by every thread of this session (PDF, text, code, data)."), 6);
        JSONArray fs = session.optJSONArray("files");
        if (fs == null || fs.length() == 0) a.add(box, muted("No files yet."), 8);
        for (int i = 0; fs != null && i < fs.length(); i++) {
            JSONObject f = fs.optJSONObject(i);
            final JSONObject ff = f;
            TextView ft = a.text("📄 " + f.optString("filename") + "  ·  " + (f.optBoolean("has_text") || f.optInt("has_text") == 1 ? "readable" : "not readable as text"), 14, MainActivity.TEXT, false);
            ft.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View v) {
                a.confirm("Remove from this session?", ff.optString("filename") + " stays in Files; threads of this session stop reading it.", new Runnable() { public void run() {
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("DELETE", "/api/work-sessions/" + sid() + "/files/" + ff.optString("id"), null); } },
                            new MainActivity.Done() { public void ok(Object r) { dlg[0].dismiss(); a.toast("Removed"); refreshThen(new Runnable() { public void run() { files(); } }); } });
                } });
                return true; } });
            a.add(box, ft, 10);
        }
        if (fs != null && fs.length() > 0) a.add(box, muted("Long-press a file to remove it from this session."), 8);
        dlg[0] = panel("Files", box);
    }

    void outputs(final boolean notes) {
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        final AlertDialog[] dlg = new AlertDialog[1];
        a.add(box, a.button(notes ? "＋ New note" : "＋ New document", false, new Runnable() { public void run() { dlg[0].dismiss(); newArtifact(notes); } }), 4);
        JSONArray as = session.optJSONArray("artifacts");
        if (as == null || as.length() == 0) a.add(box, muted("No outputs yet."), 8);
        for (int i = 0; as != null && i < as.length(); i++) {
            final JSONObject ar = as.optJSONObject(i);
            TextView t = a.text("◫ " + ar.optString("title") + "  ·  v" + ar.optInt("current_version"), 14.5f, MainActivity.TEXT, false);
            t.setPadding(0, dp(10), 0, dp(10));
            t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { showArtifact(ar.optString("id")); } });
            box.addView(t);
        }
        dlg[0] = panel(notes ? "Notes" : "Outputs", box);
    }

    void newArtifact(final boolean note) {
        LinearLayout box = a.vbox();
        final EditText t = a.input("Title", InputType.TYPE_CLASS_TEXT);
        final EditText c = a.input("Content (Markdown)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        c.setMinLines(5);
        box.addView(t); a.add(box, c, 8);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(note ? "New note" : "New document").setView(pad(box))
                .setPositiveButton("Save", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("title", t.getText().toString().trim().length() > 0 ? t.getText().toString().trim() : "Untitled", "kind", "markdown",
                            "content", c.getText().toString(), "session_id", sid());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/workspace/artifacts", b); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast("Saved to this session"); refreshThen(new Runnable() { public void run() { } }); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void showArtifact(final String id) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/workspace/artifacts/" + id).optJSONObject("artifact"); } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONObject ar = (JSONObject) r;
            String content = ar.optString("content");
            String lang = ar.optString("language");
            if ("quiz".equals(lang)) content = "Quiz — open the session's Quiz tool to practise it.";
            if ("flashcards".equals(lang)) { try { showCards(new JSONObject(content)); return; } catch (Exception ignored) { } }
            TextView t = a.text(content, 14, MainActivity.TEXT, false);
            t.setTextIsSelectable(true);
            t.setPadding(dp(18), dp(8), dp(18), dp(8));
            AlertDialog d = panel(ar.optString("title") + "  ·  v" + ar.optInt("current_version"), t);
            if (!"quiz".equals(lang)) d.setButton(DialogInterface.BUTTON_NEUTRAL, "Edit", new DialogInterface.OnClickListener() { public void onClick(DialogInterface x, int w) { editArtifact(ar); } });
        } });
    }

    void editArtifact(final JSONObject ar) {
        final EditText c = new EditText(a);
        c.setText(ar.optString("content"));
        c.setMinLines(8);
        c.setGravity(Gravity.TOP);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Edit · " + ar.optString("title")).setView(pad(c))
                .setPositiveButton("Save new version", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("content", c.getText().toString(), "note", "edited on Android");
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("PUT", "/api/workspace/artifacts/" + ar.optString("id"), b).optJSONObject("artifact"); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast("Saved as version " + ((JSONObject) r).optInt("current_version")); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    // ---------------------------------------------------------------- code: agent edits (Settings → permissions decide review vs. apply)
    void agent() {
        final String pid = pid();
        if (pid == null) return;
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        final AlertDialog[] dlg = new AlertDialog[1];
        final EditText ins = a.input("What should Approx change? (e.g. Add input validation to app.js)", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        box.addView(ins);
        a.add(box, a.button("Propose changes", true, new Runnable() { public void run() {
            final JSONObject b = MainActivity.obj("instruction", ins.getText().toString().trim(), "session_id", sid());
            a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/fabbox/" + pid + "/agent", b).optJSONObject("proposal"); } }, new MainActivity.Done() { public void ok(Object r) {
                JSONObject pr = (JSONObject) r;
                dlg[0].dismiss();
                a.toast("applied".equals(pr.optString("status")) ? "Applied (automatic permissions) — see Changes" : "Proposal ready — review it below");
                refreshThen(new Runnable() { public void run() { agent(); } });
            } });
        } }), 6);
        a.add(box, muted("Settings → Workspaces → Agent permissions: Manual = review here first; Automatic = applied at once."), 4);
        JSONArray ps = session.optJSONArray("proposals");
        if (ps == null || ps.length() == 0) a.add(box, muted("No proposals yet."), 10);
        for (int i = 0; ps != null && i < ps.length(); i++) {
            final JSONObject pr = ps.optJSONObject(i);
            StringBuilder files = new StringBuilder();
            JSONArray fl = pr.optJSONArray("files");
            for (int j = 0; fl != null && j < fl.length(); j++) files.append(fl.optString(j)).append("\n");
            a.add(box, a.text(pr.optString("status").toUpperCase() + " · " + pr.optString("summary"), 14, MainActivity.TEXT, true), 14);
            TextView f = a.text(files.toString().trim(), 12.5f, MainActivity.CODE_TEXT, false);
            f.setTypeface(Typeface.MONOSPACE);
            a.add(box, f, 2);
            if ("pending".equals(pr.optString("status"))) {
                LinearLayout row = a.hbox();
                for (final String dcs : new String[]{"approve", "reject"}) {
                    row.addView(a.link("approve".equals(dcs) ? "Approve & apply" : "Reject", new Runnable() { public void run() {
                        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/fabbox/" + pid + "/proposals/" + pr.optString("id") + "/" + dcs, new JSONObject()); } },
                                new MainActivity.Done() { public void ok(Object x) { dlg[0].dismiss(); a.toast("approve".equals(dcs) ? "Applied — see Changes" : "Rejected"); refreshThen(new Runnable() { public void run() { agent(); } }); } });
                    } }));
                    View sp = new View(a); row.addView(sp, new LinearLayout.LayoutParams(dp(24), 1));
                }
                a.add(box, row, 4);
            }
        }
        dlg[0] = panel("Agent", box);
    }

    // ---------------------------------------------------------------- education: flashcards + study plan
    void flashcards() {
        final EditText topic = a.input("Topic (optional)", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Flashcards from this session's material").setView(pad(topic))
                .setPositiveButton("Create", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("count", 12, "topic", topic.getText().toString().trim());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/flashcards", b).optJSONObject("flashcards"); } },
                            new MainActivity.Done() { public void ok(Object r) { showCards((JSONObject) r); refreshThen(new Runnable() { public void run() { } }); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    /** One card at a time: tap to flip, Next for the following card. */
    void showCards(final JSONObject set) {
        final JSONArray cards = set.optJSONArray("cards");
        if (cards == null || cards.length() == 0) { a.toast("No cards"); return; }
        final int[] i = {0}; final boolean[] back = {false};
        final TextView face = a.text("", 18, MainActivity.TEXT, true);
        face.setGravity(Gravity.CENTER);
        face.setMinHeight(dp(180));
        face.setPadding(dp(16), dp(16), dp(16), dp(16));
        face.setBackground(a.bgShape(MainActivity.GREEN_SOFT, 16, MainActivity.LINE));
        final TextView counter = muted("");
        final Runnable draw = new Runnable() { public void run() {
            JSONObject c = cards.optJSONObject(i[0]);
            face.setText(back[0] ? c.optString("back") : c.optString("front"));
            counter.setText("Card " + (i[0] + 1) + " of " + cards.length() + " · " + (back[0] ? "answer" : "tap to flip"));
        } };
        face.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { back[0] = !back[0]; draw.run(); } });
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(8), dp(18), dp(8));
        box.addView(face); a.add(box, counter, 8);
        draw.run();
        AlertDialog d = new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(set.optString("title")).setView(box)
                .setPositiveButton("Next", null).setNegativeButton("Close", null).show();
        d.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() { public void onClick(View v) { i[0] = (i[0] + 1) % cards.length(); back[0] = false; draw.run(); } });
    }

    void studyPlan() {
        LinearLayout box = a.vbox();
        final EditText days = a.input("Number of days (1–30)", InputType.TYPE_CLASS_NUMBER);
        days.setText("7");
        box.addView(days);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Study plan").setView(pad(box))
                .setMessage("Approx plans the material day by day and adds one dated assignment per day (see Assignments and Progress).")
                .setPositiveButton("Create plan", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    int n; try { n = Integer.parseInt(days.getText().toString().trim()); } catch (Exception e) { n = 7; }
                    final JSONObject b = MainActivity.obj("days", n);
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/study-plan", b).optJSONObject("plan"); } },
                            new MainActivity.Done() { public void ok(Object r) { JSONObject p2 = (JSONObject) r; a.toast(p2.optInt("assignments") + " daily assignments added"); refreshThen(new Runnable() { public void run() { tasks("assignment"); } }); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void logs() {
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        JSONArray ls = session.optJSONArray("logs");
        if (ls == null || ls.length() == 0) a.add(box, muted("No tool runs yet. Planning, quizzes, commits and run attempts are logged here."), 8);
        for (int i = 0; ls != null && i < ls.length(); i++) {
            JSONObject l = ls.optJSONObject(i);
            a.add(box, a.text(l.optString("tool") + " · " + l.optString("status") + " · " + DateUtils.getRelativeTimeSpanString(l.optLong("created_at")), 13, MainActivity.TEXT, true), 10);
            a.add(box, a.text(l.optString("input") + "\n→ " + l.optString("output"), 12.5f, MainActivity.MUTED, false), 2);
        }
        panel("Logs", box);
    }

    // ---------------------------------------------------------------- code tools
    void repoFiles() {
        final String pid = pid();
        if (pid == null) { a.toast("This session has no repository."); return; }
        a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/fabbox/" + pid + "/files"); } }, new MainActivity.Done() { public void ok(Object r) {
            LinearLayout box = a.vbox();
            box.setPadding(dp(18), dp(6), dp(18), dp(6));
            final AlertDialog[] dlg = new AlertDialog[1];
            a.add(box, a.button("＋ New file", false, new Runnable() { public void run() { dlg[0].dismiss(); editFile(pid, null, ""); } }), 4);
            JSONArray fs = ((JSONObject) r).optJSONArray("files");
            if (fs.length() == 0) a.add(box, muted("The repository is empty."), 8);
            for (int i = 0; i < fs.length(); i++) {
                final String path = fs.optJSONObject(i).optString("path");
                TextView t = a.text(path + "  ·  " + fs.optJSONObject(i).optInt("size") + " B", 14, MainActivity.TEXT, false);
                t.setTypeface(Typeface.MONOSPACE);
                t.setPadding(0, dp(9), 0, dp(9));
                t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                    dlg[0].dismiss();
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.get("/api/fabbox/" + pid + "/file?path=" + Api.enc(path)).optJSONObject("file"); } },
                            new MainActivity.Done() { public void ok(Object f) { editFile(pid, path, ((JSONObject) f).optString("content")); } });
                } });
                box.addView(t);
            }
            dlg[0] = panel("Files · " + session.optJSONObject("project").optString("name"), box);
        } });
    }

    void editFile(final String pid, final String path, String content) {
        LinearLayout box = a.vbox();
        final EditText p = a.input("path/to/file.js", InputType.TYPE_CLASS_TEXT);
        if (path != null) { p.setText(path); p.setEnabled(false); }
        final EditText c = new EditText(a);
        c.setText(content);
        c.setTypeface(Typeface.MONOSPACE);
        c.setTextSize(12.5f);
        c.setTextColor(MainActivity.CODE_TEXT);
        c.setBackground(a.bgShape(MainActivity.CODE_BG, 8, MainActivity.LINE));
        c.setPadding(dp(10), dp(8), dp(10), dp(8));
        c.setGravity(Gravity.TOP);
        c.setMinLines(12);
        c.setHorizontallyScrolling(true);
        box.addView(p); a.add(box, c, 8);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(path == null ? "New file" : path).setView(pad(box))
                .setPositiveButton("Save", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("path", p.getText().toString().trim(), "content", c.getText().toString());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.request("PUT", "/api/fabbox/" + pid + "/file", b); } },
                            new MainActivity.Done() { public void ok(Object r) { a.toast("Saved · see Changes"); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void changes() {
        final String pid = pid();
        if (pid == null) return;
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject st = a.api.get("/api/code/" + pid + "/status");
            st.put("diffs", a.api.get("/api/code/" + pid + "/diff").optJSONArray("diffs"));
            return st;
        } }, new MainActivity.Done() { public void ok(Object r) {
            JSONObject st = (JSONObject) r;
            LinearLayout box = a.vbox();
            box.setPadding(dp(14), dp(6), dp(14), dp(6));
            box.addView(a.text("Branch " + st.optString("branch") + " · " + st.optJSONArray("changes").length() + " changed file(s)", 13.5f, MainActivity.MUTED, true));
            JSONArray ds = st.optJSONArray("diffs");
            if (ds.length() == 0) a.add(box, muted("Working tree clean — nothing changed since the last commit."), 8);
            for (int i = 0; i < ds.length(); i++) {
                JSONObject d = ds.optJSONObject(i);
                a.add(box, a.text(d.optString("status").toUpperCase() + "  " + d.optString("path"), 13.5f, MainActivity.TEXT, true), 10);
                TextView t = a.text(d.optString("diff"), 11.5f, MainActivity.CODE_TEXT, false);
                t.setTypeface(Typeface.MONOSPACE);
                t.setBackground(a.bgShape(MainActivity.CODE_BG, 8, MainActivity.LINE));
                t.setPadding(dp(8), dp(6), dp(8), dp(6));
                t.setTextIsSelectable(true);
                a.add(box, t, 4);
            }
            panel("Changes", box);
        } });
    }

    void commit() {
        final String pid = pid();
        if (pid == null) return;
        final EditText m = a.input("Commit message", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Commit").setView(pad(m))
                .setPositiveButton("Commit", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("message", m.getText().toString().trim(), "session_id", sid());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/code/" + pid + "/commit", b).optJSONObject("commit"); } },
                            new MainActivity.Done() { public void ok(Object r) { JSONObject c = (JSONObject) r; a.toast("Committed " + c.optJSONArray("files").length() + " file(s) to " + c.optString("branch")); refreshThen(new Runnable() { public void run() { } }); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void branches() {
        final String pid = pid();
        if (pid == null) return;
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject b = a.api.get("/api/code/" + pid + "/branches");
            b.put("log", a.api.get("/api/code/" + pid + "/log").optJSONArray("commits"));
            return b;
        } }, new MainActivity.Done() { public void ok(Object r) {
            final JSONObject o = (JSONObject) r;
            LinearLayout box = a.vbox();
            box.setPadding(dp(18), dp(6), dp(18), dp(6));
            final AlertDialog[] dlg = new AlertDialog[1];
            final EditText nb = a.input("New branch name (e.g. feature/login)", InputType.TYPE_CLASS_TEXT);
            box.addView(nb);
            a.add(box, a.button("Create branch from " + o.optString("current"), false, new Runnable() { public void run() {
                final String n = nb.getText().toString().trim();
                a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/code/" + pid + "/branches", MainActivity.obj("name", n)); } },
                        new MainActivity.Done() { public void ok(Object x) { dlg[0].dismiss(); a.toast("Branch " + n + " created"); branches(); } });
            } }), 6);
            JSONArray bs = o.optJSONArray("branches");
            for (int i = 0; i < bs.length(); i++) {
                final String n = bs.optJSONObject(i).optString("name");
                boolean cur = n.equals(o.optString("current"));
                TextView t = a.text((cur ? "● " : "○ ") + n + (cur ? "  (current)" : "  · tap to switch"), 14, cur ? MainActivity.GREEN_TEXT : MainActivity.TEXT, cur);
                t.setPadding(0, dp(9), 0, dp(9));
                if (!cur) t.setOnClickListener(new View.OnClickListener() { public void onClick(View v) {
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/code/" + pid + "/checkout", MainActivity.obj("branch", n)); } },
                            new MainActivity.Done() { public void ok(Object x) { dlg[0].dismiss(); a.toast("Switched to " + n); } });
                } });
                box.addView(t);
            }
            a.add(box, a.text("History of " + o.optString("current"), 13, MainActivity.MUTED, true), 12);
            JSONArray log = o.optJSONArray("log");
            if (log.length() == 0) a.add(box, muted("No commits yet."), 4);
            for (int i = 0; i < log.length(); i++) {
                JSONObject c = log.optJSONObject(i);
                a.add(box, a.text(c.optString("id").substring(4, 11) + "  " + c.optString("message") + "  · " + DateUtils.getRelativeTimeSpanString(c.optLong("created_at")), 12.5f, MainActivity.TEXT, false), 6);
            }
            dlg[0] = panel("Branches & history", box);
        } });
    }

    void runner() {
        final String pid = pid();
        if (pid == null) return;
        LinearLayout box = a.vbox();
        final EditText cmd = a.input("Command (e.g. npm test)", InputType.TYPE_CLASS_TEXT);
        box.addView(cmd);
        final RadioGroup rg = new RadioGroup(a);
        rg.setOrientation(RadioGroup.HORIZONTAL);
        final String[] kinds = {"terminal", "run", "test", "build"};
        for (int i = 0; i < kinds.length; i++) { RadioButton rb = new RadioButton(a); rb.setText(MainActivity.cap(kinds[i])); rb.setId(1000 + i); rg.addView(rb); }
        rg.check(1000);
        a.add(box, rg, 8);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Terminal · Run · Test · Build").setView(pad(box))
                .setPositiveButton("Run", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("command", cmd.getText().toString().trim(), "kind", kinds[rg.getCheckedRadioButtonId() - 1000], "session_id", sid());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception {
                        try { return a.api.post("/api/code/" + pid + "/run", b); }
                        catch (Api.ApiException e) { if ("runner_not_configured".equals(e.code)) return MainActivity.obj("unavailable", e.getMessage()); throw e; }
                    } }, new MainActivity.Done() { public void ok(Object r) {
                        JSONObject o = (JSONObject) r;
                        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Not run")
                                .setMessage(o.optString("unavailable", o.toString())).setPositiveButton("OK", null).show();
                        refreshThen(new Runnable() { public void run() { } });
                    } });
                } }).setNegativeButton("Cancel", null).show();
    }

    // ---------------------------------------------------------------- education tools
    void quiz() {
        final EditText topic = a.input("Topic (optional — default: the whole material)", InputType.TYPE_CLASS_TEXT);
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Quiz from this session's material").setView(pad(topic))
                .setPositiveButton("Create quiz", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    final JSONObject b = MainActivity.obj("count", 5, "topic", topic.getText().toString().trim());
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/quiz", b).optJSONObject("quiz"); } },
                            new MainActivity.Done() { public void ok(Object r) { takeQuiz((JSONObject) r); } });
                } }).setNegativeButton("Cancel", null).show();
    }

    void takeQuiz(final JSONObject q) {
        LinearLayout box = a.vbox();
        box.setPadding(dp(18), dp(6), dp(18), dp(6));
        final JSONArray qs = q.optJSONArray("questions");
        final List<RadioGroup> groups = new ArrayList<>();
        for (int i = 0; i < qs.length(); i++) {
            JSONObject x = qs.optJSONObject(i);
            a.add(box, a.text((i + 1) + ". " + x.optString("question"), 15, MainActivity.TEXT, true), 12);
            RadioGroup rg = new RadioGroup(a);
            JSONArray opts = x.optJSONArray("options");
            for (int j = 0; j < opts.length(); j++) { RadioButton rb = new RadioButton(a); rb.setText((char) ('A' + j) + ". " + opts.optString(j)); rb.setId(5000 + i * 10 + j); rg.addView(rb); }
            groups.add(rg);
            box.addView(rg);
        }
        new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle(q.optString("title")).setView(scroll(box))
                .setPositiveButton("Submit", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                    JSONArray ans = new JSONArray();
                    for (int i = 0; i < groups.size(); i++) { int id = groups.get(i).getCheckedRadioButtonId(); ans.put(id < 0 ? -1 : (id - 5000) % 10); }
                    final JSONObject b = MainActivity.obj("answers", ans);
                    a.bg(new MainActivity.Job() { public Object run() throws Exception { return a.api.post("/api/work-sessions/" + sid() + "/quiz/" + q.optString("artifact_id") + "/attempt", b); } },
                            new MainActivity.Done() { public void ok(Object r) {
                                JSONObject o = (JSONObject) r;
                                StringBuilder sb = new StringBuilder("Score: " + o.optInt("score") + "/" + o.optInt("total") + " (" + o.optInt("percent") + "%)\n");
                                JSONArray res = o.optJSONArray("results");
                                for (int i = 0; i < res.length(); i++) {
                                    JSONObject x = res.optJSONObject(i);
                                    sb.append("\n").append(i + 1).append(". ").append(x.optBoolean("correct") ? "✓ correct" : "✗ answer " + (char) ('A' + x.optInt("answer")));
                                    if (x.optString("explanation").length() > 0) sb.append(" — ").append(x.optString("explanation"));
                                }
                                new AlertDialog.Builder(a, android.R.style.Theme_Material_Light_Dialog_Alert).setTitle("Result").setMessage(sb.toString()).setPositiveButton("OK", null).show();
                            } });
                } }).setNegativeButton("Later", null).show();
    }

    // ================================================================= small views
    View sessionRow(final JSONObject s) {
        String meta = (s.isNull("project") ? "" : s.optJSONObject("project").optString("name") + " · ") + s.optInt("thread_count") + " thread" + (s.optInt("thread_count") == 1 ? "" : "s")
                + (s.optInt("open_tasks") > 0 ? " · " + s.optInt("open_tasks") + " open task" + (s.optInt("open_tasks") == 1 ? "" : "s") : "")
                + " · " + DateUtils.getRelativeTimeSpanString(s.optLong("updated_at"));
        View v = card((s.has("kind") && a.workspace == null ? glyph(s.optString("kind")) + "  " : "") + s.optString("title"), meta, new Runnable() { public void run() { open(s.optString("id"), null); } });
        v.setOnLongClickListener(new View.OnLongClickListener() { public boolean onLongClick(View x) {
            session = s; sessionMenu(); return true; } });
        return v;
    }

    View card(String title, String sub, final Runnable r) {
        LinearLayout c = a.vbox();
        c.setPadding(dp(14), dp(11), dp(14), dp(11));
        c.setBackground(r == null ? a.bgShape(MainActivity.SURFACE, 14, MainActivity.LINE) : a.pressable(a.bgShape(MainActivity.SURFACE, 14, MainActivity.LINE), a.bgShape(MainActivity.SURFACE3, 14, MainActivity.LINE)));
        TextView t = a.text(title, 15, MainActivity.TEXT, true);
        t.setMaxLines(2);
        c.addView(t);
        if (sub != null && sub.length() > 0) c.addView(a.text(sub, 12.5f, MainActivity.MUTED, false));
        if (r != null) { c.setClickable(true); c.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { r.run(); } }); }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.topMargin = dp(6);
        c.setLayoutParams(lp);
        return c;
    }

    TextView muted(String s) { TextView t = a.text(s, 13.5f, MainActivity.MUTED, false); t.setPadding(0, dp(6), 0, dp(4)); return t; }

    void section(LinearLayout parent, String label) { a.add(parent, a.text(label, 13, MainActivity.MUTED, true), 20); }

    LinearLayout sectionWithAction(LinearLayout parent, String label, String action, final Runnable r) {
        LinearLayout row = a.hbox();
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(a.text(label, 13, MainActivity.MUTED, true), new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(a.link(action, r));
        a.add(parent, row, 18);
        return row;
    }

    LinearLayout sectionWithLoad(LinearLayout parent, String label, String action, Runnable r) {
        if (action != null) sectionWithAction(parent, label, action, r); else section(parent, label);
        LinearLayout box = a.vbox();
        parent.addView(box);
        return box;
    }

    /** Practise a saved quiz again (questions only; the server marks the answers). */
    void practise(final String sessionId, final String artifactId) {
        a.bg(new MainActivity.Job() { public Object run() throws Exception {
            JSONObject o = a.api.get("/api/work-sessions/" + sessionId + "/quiz/" + artifactId);
            session = a.api.get("/api/work-sessions/" + sessionId).optJSONObject("session");
            return o.optJSONObject("quiz");
        } }, new MainActivity.Done() { public void ok(Object r) { takeQuiz((JSONObject) r); } });
    }

    View pad(View v) { LinearLayout l = a.vbox(); l.setPadding(dp(20), dp(8), dp(20), dp(4)); l.addView(v); return l; }
    View scroll(View v) { ScrollView s = new ScrollView(a); s.addView(v); return s; }
}
