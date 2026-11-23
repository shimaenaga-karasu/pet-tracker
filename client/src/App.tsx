import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Tracker = ApiResponse<typeof api, "getTracker">;
type Pet = Tracker["pets"][number];
type PetRecord = Tracker["records"][number];
type DailyLog = Tracker["daily_logs"][number];
type Kind = PetRecord["kind"];

const PET_COLORS: Record<string, { main: string; soft: string }> = {
  "サナ": { main: "#a8741a", soft: "#f7ecd4" },
  "おはぎ": { main: "#a34a6e", soft: "#f9e3ec" },
};
const FALLBACK_COLORS = [
  { main: "#a8741a", soft: "#f7ecd4" },
  { main: "#a34a6e", soft: "#f9e3ec" },
];

function petColor(pet: Pet, index: number): { main: string; soft: string } {
  return PET_COLORS[pet.name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? FALLBACK_COLORS[0]!;
}

const LOG_CATEGORIES = ["うんち", "おしっこ", "ごはん", "お水", "散歩", "体調・様子", "お薬", "その他"];
const STOOL_HARDNESS = ["硬い", "普通", "やわらかい", "水っぽい"];
const STOOL_COLOR = ["茶色", "濃い茶色", "黒っぽい", "黄色っぽい", "赤みがある", "その他"];
const STOOL_AMOUNT = ["少量", "普通", "多量"];

const KIND_ORDER: Kind[] = ["vaccination", "health", "medication", "food"];

const SECTION_META: Record<
  Kind,
  { title: string; addLabel: string; emptyText: string; accent: string }
> = {
  vaccination: {
    title: "ワクチン・予防接種",
    addLabel: "接種記録を追加",
    emptyText: "まだ接種記録がありません。狂犬病や混合ワクチンなど、接種したらここに追加できます。",
    accent: "var(--accent)",
  },
  health: {
    title: "アレルギー・持病の記録",
    addLabel: "アレルギー・持病を追加",
    emptyText: "まだ記録がありません。アレルギーや気になる症状、通院中のことがあれば追加できます。",
    accent: "var(--sage)",
  },
  medication: {
    title: "お薬・予防サイクル",
    addLabel: "お薬・予防を追加",
    emptyText: "まだ記録がありません。ノミ・マダニ予防、駆虫、フィラリア予防、治療薬などを追加できます。",
    accent: "var(--accent)",
  },
  food: {
    title: "フード・おやつの再注文",
    addLabel: "フード・おやつを追加",
    emptyText: "まだ登録がありません。いつものフードやおやつを登録すると、再注文の目安を管理できます。",
    accent: "var(--sage)",
  },
};

const CATEGORY_OPTIONS: Record<Kind, string[]> = {
  vaccination: [],
  health: ["アレルギー", "持病・治療中", "経過観察", "その他"],
  medication: ["ノミ予防", "ダニ（マダニ）予防", "ノミ・マダニ予防", "駆虫（お腹の虫）", "フィラリア予防", "治療薬", "サプリメント", "その他"],
  food: ["フード", "おやつ", "その他"],
};

const STATUS_OPTIONS: Record<Kind, string[]> = {
  vaccination: [],
  health: ["継続中", "経過観察", "解消した"],
  medication: [],
  food: ["在庫あり", "そろそろ注文", "注文済み"],
};

function todayTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function nowTimeTokyo(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTimeValue(totalMinutes: number): string {
  const t = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// Deterministic stand-in ID for CSV rows that carry no ID, so importing the
// same file twice still dedupes instead of doubling the records.
function syntheticCsvId(seed: string): string {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = (h1 * 31 + c) | 0;
    h2 = (h2 * 17 + c) | 0;
  }
  return `csv-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

// Real WAN's backup files quote EVERY field (header included) and carry a
// BOM, e.g. "id","犬","排便日時",... / "uuid","おはぎ","2026-11-09T00:31",...
// A plain split(",") keeps the quotes on each value so nothing ever matched.
// This tokenizer handles quoted fields, "" escapes, BOM, and CRLF/LF.
function parseCsvTable(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

type StoolCsvRow = {
  external_id: string;
  pet_name: string;
  datetime: string;
  hardness: string;
  color: string;
  amount: string;
};

// Parses WAN's backup CSV text. Columns are located by header NAME
// (id, 犬, 排便日時, 状態, 色, 量) when a header row exists; otherwise the
// positional layouts (with or without a leading id column) are accepted.
// Datetimes may be "2026-11-09T00:31" or "2026-11-09 00:31".
function parseStoolCsvText(text: string): StoolCsvRow[] {
  const table = parseCsvTable(text)
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (table.length === 0) return [];
  const isDateTime = (s: string) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
  const header = table[0] ?? [];
  const nameIdx = (name: string) => header.findIndex((c) => c === name);
  const byHeader = nameIdx("排便日時") >= 0 || nameIdx("犬") >= 0;
  const idx = byHeader
    ? {
        id: nameIdx("id"),
        pet: nameIdx("犬"),
        dt: nameIdx("排便日時"),
        hardness: nameIdx("状態"),
        color: nameIdx("色"),
        amount: nameIdx("量"),
      }
    : null;
  const at = (cols: string[], i: number) => (i >= 0 ? (cols[i] ?? "") : "");
  const out: StoolCsvRow[] = [];
  for (let r = byHeader ? 1 : 0; r < table.length; r++) {
    const cols = table[r] ?? [];
    let external_id = "";
    let pet_name = "";
    let datetime = "";
    let hardness = "";
    let color = "";
    let amount = "";
    if (idx) {
      external_id = at(cols, idx.id);
      pet_name = at(cols, idx.pet);
      datetime = at(cols, idx.dt);
      hardness = at(cols, idx.hardness);
      color = at(cols, idx.color);
      amount = at(cols, idx.amount);
    } else if (cols.length >= 6 && isDateTime(cols[2] ?? "")) {
      [external_id, pet_name, datetime, hardness, color, amount] = cols as [string, string, string, string, string, string];
    } else if (cols.length >= 5 && isDateTime(cols[1] ?? "")) {
      pet_name = cols[0] ?? "";
      datetime = cols[1] ?? "";
      hardness = cols[2] ?? "";
      color = cols[3] ?? "";
      amount = cols[4] ?? "";
    } else {
      continue;
    }
    if (!pet_name || !isDateTime(datetime)) continue;
    datetime = datetime.replace(" ", "T").slice(0, 16);
    if (!external_id) {
      external_id = syntheticCsvId(`${pet_name}|${datetime}|${hardness}|${color}|${amount}`);
    }
    out.push({ external_id, pet_name, datetime, hardness, color, amount });
  }
  return out;
}

function formatDate(value: string | null): string {
  if (!value) return "未入力";
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  const wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] ?? "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${wd}）`;
}

type DueState = "overdue" | "soon" | "future" | "none";

function dueState(dateNext: string | null, today: string): DueState {
  if (!dateNext) return "none";
  if (dateNext < today) return "overdue";
  const soon = new Date(`${today}T00:00:00`);
  soon.setDate(soon.getDate() + 30);
  const limit = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  return dateNext <= limit ? "soon" : "future";
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  const empty = value == null || value === "";
  return (
    <div className="flex gap-2 text-sm">
      <span className="shrink-0 text-[var(--dim)]">{label}</span>
      <span className={empty ? "text-[var(--dim)] italic" : "text-[var(--text)]"}>
        {empty ? "未入力" : value}
      </span>
    </div>
  );
}

type FormState = {
  id: number | null;
  kind: Kind;
  title: string;
  category: string;
  date_done: string;
  date_next: string;
  detail: string;
  status: string;
  amount: string;
  memo: string;
};

function emptyForm(kind: Kind): FormState {
  return {
    id: null,
    kind,
    title: "",
    category: CATEGORY_OPTIONS[kind][0] ?? "",
    date_done: "",
    date_next: "",
    detail: "",
    status: STATUS_OPTIONS[kind][0] ?? "",
    amount: "",
    memo: "",
  };
}

function formFromRecord(r: PetRecord): FormState {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    category: r.category ?? "",
    date_done: r.date_done ?? "",
    date_next: r.date_next ?? "",
    detail: r.detail ?? "",
    status: r.status ?? "",
    amount: r.amount ?? "",
    memo: r.memo ?? "",
  };
}

const inputCls =
  "w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelCls = "block text-sm font-medium text-[var(--dim)] mb-1";

function RecordForm({
  pet,
  form,
  onClose,
}: {
  pet: Pet;
  form: FormState;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<FormState>(form);
  const meta = SECTION_META[state.kind];
  const categories = CATEGORY_OPTIONS[state.kind];
  const statuses = STATUS_OPTIONS[state.kind];

  const save = useMutation({
    mutationFn: () =>
      api.saveRecord({
        id: state.id,
        pet_id: pet.id,
        kind: state.kind,
        title: state.title.trim(),
        category: categories.length ? state.category || null : null,
        date_done: state.date_done || null,
        date_next: state.date_next || null,
        detail: state.detail.trim() || null,
        status: statuses.length ? state.status || null : null,
        amount: state.kind === "food" ? state.amount.trim() || null : null,
        memo: state.memo.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tracker"] });
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteRecord({ id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tracker"] });
      onClose();
    },
  });

  const dateLabels: Record<Kind, { done: string; next: string }> = {
    vaccination: { done: "接種日", next: "次回接種の目安" },
    health: { done: "気づいた日・診断日", next: "次回通院・確認の目安" },
    medication: { done: "前回投与日", next: "次回投与日" },
    food: { done: "前回購入日", next: "再注文の目安日" },
  };
  const titleLabel: Record<Kind, string> = {
    vaccination: "ワクチンの名前",
    health: "アレルギー・病名・症状",
    medication: "お薬・製品の名前",
    food: "商品名",
  };
  const detailLabel: Record<Kind, string> = {
    vaccination: "接種した病院",
    health: "詳細（症状・原因など）",
    medication: "用量・与え方",
    food: "購入先（お店・サイトなど）",
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!state.title.trim() || save.isPending) return;
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 sm:items-center" role="dialog" aria-modal="true" aria-label={`${meta.title}の編集`}>
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[var(--bg)] p-5 pb-safe sm:rounded-3xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-[var(--text)]">
            {state.id ? "記録を編集" : meta.addLabel} — {pet.name}
          </h3>
          <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm text-[var(--text)]">
            閉じる
          </button>
        </div>

        <div className="space-y-4">
          {categories.length > 0 && (
            <div>
              <label className={labelCls} htmlFor="f-category">種類</label>
              <select id="f-category" className={inputCls} value={state.category} onChange={(e) => setState({ ...state, category: e.target.value })}>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="f-title">{titleLabel[state.kind]}（必須）</label>
            <input id="f-title" className={inputCls} value={state.title} onChange={(e) => setState({ ...state, title: e.target.value })} placeholder="未入力" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="f-done">{dateLabels[state.kind].done}</label>
              <input id="f-done" type="date" className={inputCls} value={state.date_done} onChange={(e) => setState({ ...state, date_done: e.target.value })} />
            </div>
            <div>
              <label className={labelCls} htmlFor="f-next">{dateLabels[state.kind].next}</label>
              <input id="f-next" type="date" className={inputCls} value={state.date_next} onChange={(e) => setState({ ...state, date_next: e.target.value })} />
            </div>
          </div>
          {state.kind === "food" && (
            <div>
              <label className={labelCls} htmlFor="f-amount">残量・在庫の目安</label>
              <input id="f-amount" className={inputCls} value={state.amount} onChange={(e) => setState({ ...state, amount: e.target.value })} placeholder="例：あと約1週間分" />
            </div>
          )}
          {statuses.length > 0 && (
            <div>
              <label className={labelCls} htmlFor="f-status">状態</label>
              <select id="f-status" className={inputCls} value={state.status} onChange={(e) => setState({ ...state, status: e.target.value })}>
                {statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="f-detail">{detailLabel[state.kind]}</label>
            <input id="f-detail" className={inputCls} value={state.detail} onChange={(e) => setState({ ...state, detail: e.target.value })} placeholder="未入力" />
          </div>
          <div>
            <label className={labelCls} htmlFor="f-memo">メモ</label>
            <textarea id="f-memo" className={inputCls} rows={3} value={state.memo} onChange={(e) => setState({ ...state, memo: e.target.value })} placeholder="未入力" />
          </div>
        </div>

        {save.isError && <p className="mt-3 text-sm text-[var(--warn)]">保存できませんでした。もう一度お試しください。</p>}

        <div className="sticky bottom-0 mt-5 flex items-center gap-3 bg-[var(--bg)] pb-1 pt-3">
          <button
            type="submit"
            disabled={!state.title.trim() || save.isPending}
            className="flex-1 rounded-full bg-[var(--accent)] px-5 py-3 font-display text-base font-bold text-white disabled:opacity-40"
          >
            {save.isPending ? "保存中…" : "保存する"}
          </button>
          {state.id != null && (
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate(state.id as number)}
              className="rounded-full border border-[var(--warn)] px-4 py-3 text-sm font-medium text-[var(--warn)]"
            >
              削除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function PetProfileForm({ pet, onClose }: { pet: Pet; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(pet.name);
  const [breed, setBreed] = useState(pet.breed);
  const [sex, setSex] = useState(pet.sex ?? "");
  const [age, setAge] = useState(pet.age_years != null ? String(pet.age_years) : "");
  const [birthDate, setBirthDate] = useState(pet.birth_date ?? "");
  const [weight, setWeight] = useState(pet.weight ?? "");
  const [vet, setVet] = useState(pet.vet_name ?? "");
  const [notes, setNotes] = useState(pet.notes ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.updatePet({
        id: pet.id,
        name: name.trim(),
        breed: breed.trim(),
        sex: sex || null,
        age_years: age.trim() === "" ? null : Number(age),
        birth_date: birthDate || null,
        weight: weight.trim() || null,
        vet_name: vet.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tracker"] });
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || save.isPending) return;
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 sm:items-center" role="dialog" aria-modal="true" aria-label="基本情報の編集">
      <form onSubmit={submit} className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[var(--bg)] p-5 pb-safe sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-[var(--text)]">{pet.name}の基本情報を編集</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm text-[var(--text)]">
            閉じる
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className={labelCls} htmlFor="p-name">名前（必須）</label>
            <input id="p-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="p-breed">犬種</label>
            <input id="p-breed" className={inputCls} value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="未入力" />
          </div>
          <div>
            <label className={labelCls} htmlFor="p-sex">性別</label>
            <select id="p-sex" className={inputCls} value={sex} onChange={(e) => setSex(e.target.value)}>
              <option value="">未入力</option>
              <option value="メス">メス</option>
              <option value="オス">オス</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="p-age">年齢（歳）</label>
              <input id="p-age" type="number" min={0} max={40} className={inputCls} value={age} onChange={(e) => setAge(e.target.value)} placeholder="未入力" />
            </div>
            <div>
              <label className={labelCls} htmlFor="p-birth">誕生日・うちの子記念日</label>
              <input id="p-birth" type="date" className={inputCls} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="p-weight">体重</label>
            <input id="p-weight" className={inputCls} value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="未入力（例：3.2kg）" />
          </div>
          <div>
            <label className={labelCls} htmlFor="p-vet">かかりつけの動物病院</label>
            <input id="p-vet" className={inputCls} value={vet} onChange={(e) => setVet(e.target.value)} placeholder="未入力" />
          </div>
          <div>
            <label className={labelCls} htmlFor="p-notes">メモ</label>
            <textarea id="p-notes" className={inputCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="未入力" />
          </div>
        </div>
        {save.isError && <p className="mt-3 text-sm text-[var(--warn)]">保存できませんでした。もう一度お試しください。</p>}
        <div className="sticky bottom-0 bg-[var(--bg)] pb-1 pt-3">
          <button
            type="submit"
            disabled={!name.trim() || save.isPending}
            className="w-full rounded-full bg-[var(--accent)] px-5 py-3 font-display text-base font-bold text-white disabled:opacity-40"
          >
            {save.isPending ? "保存中…" : "保存する"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RecordCard({ record, today, onEdit }: { record: PetRecord; today: string; onEdit: () => void }) {
  const due = dueState(record.date_next, today);
  const dateDoneLabel: Record<Kind, string> = {
    vaccination: "接種日",
    health: "記録日",
    medication: "前回",
    food: "前回購入",
  };
  const dateNextLabel: Record<Kind, string> = {
    vaccination: "次回",
    health: "次回確認",
    medication: "次回",
    food: "再注文目安",
  };
  return (
    <li className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-bold text-[var(--text)]">{record.title}</p>
          {record.category && (
            <span className="mt-1 inline-block rounded-full bg-[var(--surface-alt)] px-2.5 py-0.5 text-xs font-medium text-[var(--dim)]">{record.category}</span>
          )}
          {record.status && (
            <span className="ml-1.5 mt-1 inline-block rounded-full bg-[var(--sage-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--sage)]">{record.status}</span>
          )}
        </div>
        <button type="button" onClick={onEdit} aria-label={`${record.title}を編集`} className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--accent)]">
          編集
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        <Field label={dateDoneLabel[record.kind]} value={record.date_done ? formatDate(record.date_done) : null} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--dim)]">{dateNextLabel[record.kind]}</span>
          {record.date_next ? (
            <>
              <span className="text-[var(--text)]">{formatDate(record.date_next)}</span>
              {due === "overdue" && <span className="rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-xs font-bold text-[var(--warn)]">期限を過ぎています</span>}
              {due === "soon" && <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-bold text-[var(--accent)]">もうすぐ</span>}
            </>
          ) : (
            <span className="italic text-[var(--dim)]">未入力</span>
          )}
        </div>
        {record.kind === "food" && <Field label="残量" value={record.amount} />}
        <Field label={record.kind === "vaccination" ? "病院" : record.kind === "food" ? "購入先" : "詳細"} value={record.detail} />
        <Field label="メモ" value={record.memo} />
      </div>
    </li>
  );
}

function TimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const has = /^\d{2}:\d{2}$/.test(value);
  const baseStr = has ? value : nowTimeTokyo();
  const [baseH = 0, baseM = 0] = baseStr.split(":").map(Number);
  const baseTotal = baseH * 60 + baseM;

  const stepBtnCls =
    "flex h-14 flex-1 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--bg)] font-display text-2xl font-black text-[var(--text)] active:bg-[var(--surface-alt)]";
  const quickCls =
    "rounded-full border border-[var(--border)] bg-[var(--bg)] px-4 py-2.5 text-base font-medium text-[var(--text)] active:bg-[var(--surface-alt)]";

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className={`font-display text-3xl font-black ${has ? "text-[var(--text)]" : "text-[var(--dim)]"}`} aria-live="polite">
          {has ? value : "— : —"}
        </span>
        <button
          type="button"
          onClick={() => onChange(nowTimeTokyo())}
          className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-3 font-display text-base font-bold text-white"
        >
          いまの時刻
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--dim)]">時</span>
          <div className="flex gap-2">
            <button type="button" aria-label="時刻を1時間もどす" className={stepBtnCls} onClick={() => onChange(formatTimeValue(baseTotal - 60))}>
              −
            </button>
            <button type="button" aria-label="時刻を1時間すすめる" className={stepBtnCls} onClick={() => onChange(formatTimeValue(baseTotal + 60))}>
              ＋
            </button>
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--dim)]">分</span>
          <div className="flex gap-2">
            <button type="button" aria-label="時刻を1分もどす" className={stepBtnCls} onClick={() => onChange(formatTimeValue(baseTotal - 1))}>
              −
            </button>
            <button type="button" aria-label="時刻を1分すすめる" className={stepBtnCls} onClick={() => onChange(formatTimeValue(baseTotal + 1))}>
              ＋
            </button>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="時刻をまとめて調整">
        {[-30, -15, -5, 5, 15, 30].map((delta) => (
          <button
            key={delta}
            type="button"
            aria-label={`時刻を${Math.abs(delta)}分${delta < 0 ? "もどす" : "すすめる"}`}
            className={quickCls}
            onClick={() => onChange(formatTimeValue(baseTotal + delta))}
          >
            {delta < 0 ? `−${Math.abs(delta)}分` : `＋${delta}分`}
          </button>
        ))}
      </div>
      {has && (
        <button type="button" onClick={() => onChange("")} className="mt-3 text-sm text-[var(--dim)] underline">
          時刻を消す（未入力にする）
        </button>
      )}
    </div>
  );
}

type LogFormState = {
  id: number | null;
  pet_id: number;
  log_date: string;
  log_time: string;
  category: string;
  stool_hardness: string;
  stool_color: string;
  stool_amount: string;
  detail: string;
};

function DailyLogForm({
  pets,
  initial,
  onClose,
}: {
  pets: Pet[];
  initial: LogFormState;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LogFormState>(initial);
  const isStool = state.category === "うんち";

  const save = useMutation({
    mutationFn: () =>
      api.saveDailyLog({
        id: state.id,
        pet_id: state.pet_id,
        log_date: state.log_date,
        log_time: state.log_time || null,
        category: state.category,
        stool_hardness: isStool ? state.stool_hardness || null : null,
        stool_color: isStool ? state.stool_color || null : null,
        stool_amount: isStool ? state.stool_amount || null : null,
        detail: state.detail.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tracker"] });
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!state.log_date || save.isPending) return;
    save.mutate();
  }

  const chipCls = (active: boolean) =>
    `rounded-full border-2 px-5 py-3 text-base font-medium ${active ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"}`;
  const categoryCls = (active: boolean) =>
    `rounded-2xl border-2 px-3 py-3.5 font-display text-base font-bold ${active ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"}`;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/45 sm:items-center" role="dialog" aria-modal="true" aria-label="毎日の記録の編集">
      <form onSubmit={submit} className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[var(--bg)] p-5 pb-safe sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="font-display text-lg font-bold text-[var(--text)]">{state.id ? "記録を編集" : "記録する"}</h3>
          <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 rounded-full bg-[var(--surface-alt)] px-3 py-1.5 text-sm text-[var(--text)]">
            閉じる
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <span className={labelCls}>どちらの子？</span>
            <div className="flex gap-2" role="group" aria-label="ペットを選ぶ">
              {pets.map((p, i) => {
                const c = petColor(p, i);
                const active = state.pet_id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setState({ ...state, pet_id: p.id })}
                    className="flex-1 rounded-2xl border-2 px-4 py-3 font-display text-base font-bold"
                    style={{
                      borderColor: active ? c.main : "var(--border)",
                      backgroundColor: active ? c.soft : "var(--surface)",
                      color: "var(--text)",
                    }}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="l-date">日付（必須）</label>
            <div className="flex gap-2">
              <input id="l-date" type="date" className={`${inputCls} min-w-0 flex-1`} value={state.log_date} onChange={(e) => setState({ ...state, log_date: e.target.value })} />
              <button
                type="button"
                onClick={() => setState({ ...state, log_date: shiftDate(todayTokyo(), -1) })}
                className="shrink-0 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-base font-medium text-[var(--text)]"
              >
                昨日
              </button>
              <button
                type="button"
                onClick={() => setState({ ...state, log_date: todayTokyo() })}
                className="shrink-0 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-base font-medium text-[var(--text)]"
              >
                今日
              </button>
            </div>
          </div>
          <div>
            <span className={labelCls}>時刻</span>
            <TimePicker value={state.log_time} onChange={(v) => setState({ ...state, log_time: v })} />
          </div>
          <div>
            <span className={labelCls}>記録の種類</span>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="記録の種類">
              {LOG_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={state.category === c}
                  className={categoryCls(state.category === c)}
                  onClick={() => setState({ ...state, category: c })}
                >
                  {c === "うんち" ? "うんち（排便）" : c}
                </button>
              ))}
            </div>
          </div>
          {isStool && (
            <>
              <div>
                <span className={labelCls}>硬さ</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="うんちの硬さ">
                  {STOOL_HARDNESS.map((v) => (
                    <button key={v} type="button" aria-pressed={state.stool_hardness === v} className={chipCls(state.stool_hardness === v)} onClick={() => setState({ ...state, stool_hardness: state.stool_hardness === v ? "" : v })}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className={labelCls}>色</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="うんちの色">
                  {STOOL_COLOR.map((v) => (
                    <button key={v} type="button" aria-pressed={state.stool_color === v} className={chipCls(state.stool_color === v)} onClick={() => setState({ ...state, stool_color: state.stool_color === v ? "" : v })}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className={labelCls}>量</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="うんちの量">
                  {STOOL_AMOUNT.map((v) => (
                    <button key={v} type="button" aria-pressed={state.stool_amount === v} className={chipCls(state.stool_amount === v)} onClick={() => setState({ ...state, stool_amount: state.stool_amount === v ? "" : v })}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          <div>
            <label className={labelCls} htmlFor="l-detail">様子のメモ</label>
            <textarea id="l-detail" className={inputCls} rows={3} value={state.detail} onChange={(e) => setState({ ...state, detail: e.target.value })} placeholder="未入力" />
          </div>
        </div>
        {save.isError && <p className="mt-3 text-sm text-[var(--warn)]">保存できませんでした。もう一度お試しください。</p>}
        <div className="sticky bottom-0 bg-[var(--bg)] pb-1 pt-3">
          <button type="submit" disabled={!state.log_date || save.isPending} className="w-full rounded-full bg-[var(--accent)] px-5 py-3 font-display text-base font-bold text-white disabled:opacity-40">
            {save.isPending ? "保存中…" : "保存する"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const tracker = useQuery({ queryKey: ["tracker"], queryFn: () => api.getTracker({}) });
  const [selectedPetId, setSelectedPetId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const today = todayTokyo();
  const [todayY = 2026, todayM = 11] = today.split("-").map(Number);
  const [calYear, setCalYear] = useState(todayY);
  const [calMonth, setCalMonth] = useState(todayM);
  const [selectedDate, setSelectedDate] = useState(today);
  const [logForm, setLogForm] = useState<LogFormState | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const deleteLog = useMutation({
    mutationFn: (id: number) => api.deleteDailyLog({ id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tracker"] }),
  });

  const pets = tracker.data?.pets ?? [];
  const records = tracker.data?.records ?? [];
  const dailyLogs = tracker.data?.daily_logs ?? [];
  const pet = pets.find((p) => p.id === selectedPetId) ?? pets[0];

  const petRecords = useMemo(
    () => (pet ? records.filter((r) => r.pet_id === pet.id) : []),
    [records, pet],
  );

  const upcoming = useMemo(() => {
    return petRecords
      .filter((r) => r.date_next)
      .slice()
      .sort((a, b) => (a.date_next ?? "").localeCompare(b.date_next ?? ""))
      .slice(0, 5);
  }, [petRecords]);

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4">
        {tracker.isPending && <p className="py-16 text-center text-[var(--dim)]">読み込み中…</p>}
        {tracker.isError && (
          <div className="py-16 text-center">
            <p className="text-[var(--text)]">読み込めませんでした。</p>
            <button type="button" onClick={() => void tracker.refetch()} className="mt-4 rounded-full bg-[var(--accent)] px-5 py-2.5 font-display font-bold text-white">
              もう一度読み込む
            </button>
          </div>
        )}
        {tracker.data && pets.length === 0 && (
          <p className="py-16 text-center text-[var(--dim)]">ペットが登録されていません。</p>
        )}

        {pets.length > 0 && (
          <>
            {/* Calendar / add-record switch, like the app in the screenshot */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setCalYear(todayY);
                  setCalMonth(todayM);
                  setSelectedDate(today);
                }}
                className="rounded-2xl border-2 border-[#a34a6e] bg-[#f9e3ec] px-4 py-3.5 font-display text-base font-bold text-[#7c3554]"
              >
                カレンダー
              </button>
              <button
                type="button"
                onClick={() =>
                  pet &&
                  setLogForm({
                    id: null,
                    pet_id: pet.id,
                    log_date: selectedDate,
                    log_time: selectedDate === today ? nowTimeTokyo() : "",
                    category: "うんち",
                    stool_hardness: "",
                    stool_color: "",
                    stool_amount: "",
                    detail: "",
                  })
                }
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 font-display text-base font-bold text-[var(--text)]"
              >
                ＋ 記録する
              </button>
            </div>

            {/* Monthly calendar */}
            <section aria-label="カレンダー" className="mt-4 rounded-3xl bg-[var(--surface)] p-5">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  aria-label="前の月"
                  onClick={() => {
                    if (calMonth === 1) { setCalYear(calYear - 1); setCalMonth(12); } else setCalMonth(calMonth - 1);
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] text-lg text-[var(--text)]"
                >
                  ‹
                </button>
                <h2 className="font-display text-xl font-black text-[var(--text)]">{calYear}年 {calMonth}月</h2>
                <button
                  type="button"
                  aria-label="次の月"
                  onClick={() => {
                    if (calMonth === 12) { setCalYear(calYear + 1); setCalMonth(1); } else setCalMonth(calMonth + 1);
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--border)] text-lg text-[var(--text)]"
                >
                  ›
                </button>
              </div>
              <div className="mt-3 flex gap-4 text-sm">
                {pets.map((p, i) => {
                  const c = petColor(p, i);
                  return (
                    <span key={p.id} className="flex items-center gap-1.5" style={{ color: c.main }}>
                      <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.main }} />
                      {p.name}
                    </span>
                  );
                })}
              </div>
              <div className="mt-3 grid grid-cols-7 text-center text-sm text-[var(--dim)]">
                {["日", "月", "火", "水", "木", "金", "土"].map((w) => (
                  <span key={w} className="py-1">{w}</span>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {(() => {
                  const firstDow = new Date(calYear, calMonth - 1, 1).getDay();
                  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
                  const cells: (number | null)[] = [
                    ...Array<null>(firstDow).fill(null),
                    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
                  ];
                  return cells.map((day, idx) => {
                    if (day == null) return <span key={`blank-${idx}`} />;
                    const dateStr = `${calYear}-${String(calMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                    const dayLogs = dailyLogs.filter((l) => l.log_date === dateStr);
                    const selected = dateStr === selectedDate;
                    const isToday = dateStr === today;
                    return (
                      <button
                        key={dateStr}
                        type="button"
                        aria-label={`${calMonth}月${day}日の記録`}
                        aria-pressed={selected}
                        onClick={() => setSelectedDate(dateStr)}
                        className={`flex min-h-[52px] flex-col items-center justify-start rounded-xl px-0.5 py-1.5 ${
                          selected ? "border-2 border-[#a34a6e] bg-[#f9e3ec]" : "border-2 border-transparent"
                        }`}
                      >
                        <span className={`text-base leading-tight ${selected ? "font-black text-[var(--text)]" : "text-[var(--text)]"} ${isToday && !selected ? "font-bold text-[var(--accent)]" : ""}`}>
                          {day}
                        </span>
                        {dayLogs.length > 0 && (
                          <span className="mt-0.5 flex flex-wrap justify-center gap-x-1 text-[11px] font-bold leading-tight">
                            {pets.map((p, i) => {
                              const count = dayLogs.filter((l) => l.pet_id === p.id).length;
                              if (count === 0) return null;
                              const c = petColor(p, i);
                              return (
                                <span key={p.id} style={{ color: c.main }}>
                                  {p.name.slice(0, 1)}{count}
                                </span>
                              );
                            })}
                          </span>
                        )}
                      </button>
                    );
                  });
                })()}
              </div>
            </section>

            {/* Selected day's logs */}
            <section aria-label="選んだ日の記録" className="mt-4 rounded-3xl bg-[var(--surface)] p-5">
              {(() => {
                const d = new Date(`${selectedDate}T00:00:00`);
                const wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] ?? "";
                const dayLogs = dailyLogs
                  .filter((l) => l.log_date === selectedDate)
                  .slice()
                  .sort((a, b) => (a.log_time ?? "99:99").localeCompare(b.log_time ?? "99:99"));
                return (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="font-display text-xl font-black text-[var(--text)]">
                        {d.getMonth() + 1}月{d.getDate()}日（{wd}）
                      </h3>
                      <span className="rounded-full bg-[var(--surface-alt)] px-3 py-1 text-sm text-[var(--dim)]">{dayLogs.length}件</span>
                    </div>
                    {dayLogs.length === 0 ? (
                      <p className="mt-3 text-sm text-[var(--dim)]">この日の記録はまだありません。</p>
                    ) : (
                      <ul className="mt-4 space-y-3">
                        {dayLogs.map((log) => {
                          const logPet = pets.find((p) => p.id === log.pet_id);
                          if (!logPet) return null;
                          const c = petColor(logPet, pets.indexOf(logPet));
                          const stoolLine = [log.stool_hardness, log.stool_color, log.stool_amount].filter(Boolean).join(" ／ ");
                          return (
                            <li
                              key={log.id}
                              className="rounded-2xl p-4"
                              style={{ backgroundColor: c.soft, borderLeft: `5px solid ${c.main}` }}
                            >
                              <div className="flex items-baseline justify-between gap-3">
                                <span className="font-display text-lg font-black text-[var(--text)]">{logPet.name}</span>
                                <span className="text-base text-[var(--text)]">{log.log_time ?? "時刻 未入力"}</span>
                              </div>
                              {log.category === "うんち" ? (
                                <p className="mt-2 text-base text-[var(--text)]">{stoolLine || "硬さ・色・量は未入力"}</p>
                              ) : (
                                <p className="mt-2 text-base text-[var(--text)]">
                                  {log.category}
                                  {log.detail ? `：${log.detail}` : ""}
                                </p>
                              )}
                              {log.category === "うんち" && log.detail && (
                                <p className="mt-1 text-sm text-[var(--dim)]">{log.detail}</p>
                              )}
                              <div className="mt-3 grid grid-cols-2 gap-3">
                                <button
                                  type="button"
                                  aria-label={`${logPet.name} ${log.log_time ?? ""}の記録を編集`}
                                  onClick={() =>
                                    setLogForm({
                                      id: log.id,
                                      pet_id: log.pet_id,
                                      log_date: log.log_date,
                                      log_time: log.log_time ?? "",
                                      category: log.category,
                                      stool_hardness: log.stool_hardness ?? "",
                                      stool_color: log.stool_color ?? "",
                                      stool_amount: log.stool_amount ?? "",
                                      detail: log.detail ?? "",
                                    })
                                  }
                                  className="rounded-xl bg-[var(--surface)] px-4 py-3 text-base text-[var(--text)]"
                                >
                                  編集
                                </button>
                                <button
                                  type="button"
                                  aria-label={`${logPet.name} ${log.log_time ?? ""}の記録を削除`}
                                  disabled={deleteLog.isPending}
                                  onClick={() => deleteLog.mutate(log.id)}
                                  className="rounded-xl bg-[var(--surface)] px-4 py-3 text-base text-[var(--text)]"
                                >
                                  削除
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        pet &&
                        setLogForm({
                          id: null,
                          pet_id: pet.id,
                          log_date: selectedDate,
                          log_time: selectedDate === today ? nowTimeTokyo() : "",
                          category: "うんち",
                          stool_hardness: "",
                          stool_color: "",
                          stool_amount: "",
                          detail: "",
                        })
                      }
                      className="mt-4 w-full rounded-2xl bg-[#a34a6e] px-5 py-4 font-display text-lg font-bold text-white"
                    >
                      ＋ 排便を記録する
                    </button>
                  </>
                );
              })()}
            </section>
          </>
        )}

        {pets.length > 0 && (
          <section aria-label="WAN'sカレンダーとのCSV連携" className="mt-4">
            <h2 className="font-display text-lg font-bold text-[var(--text)]">WAN's 💩管理カレンダーとの連携</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
              家族がWAN's 💩管理カレンダーに入れた記録は、あちらで書き出したCSVをここで取り込むと、このトラッカーにも入ります。逆に、ここの記録をCSVで書き出して渡すこともできます。同じ記録を取り込み直しても、二重にはなりません。
            </p>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setCalYear(todayY);
                  setCalMonth(todayM);
                  setSelectedDate(today);
                }}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-3 font-display text-base font-bold text-[var(--text)]"
              >
                今日に戻る
              </button>
              <span className="text-sm text-[var(--dim)]">全期間 {dailyLogs.length}件</span>
            </div>
            <button
              type="button"
              onClick={() => {
                const stoolLogs = dailyLogs
                  .filter((l) => l.category === "うんち")
                  .slice()
                  .sort((a, b) => `${a.log_date}T${a.log_time ?? ""}`.localeCompare(`${b.log_date}T${b.log_time ?? ""}`));
                const lines = ["id,犬,排便日時,状態,色,量"];
                for (const l of stoolLogs) {
                  const petName = pets.find((p) => p.id === l.pet_id)?.name ?? "";
                  lines.push(
                    [l.external_id ?? "", petName, `${l.log_date}T${l.log_time ?? "00:00"}`, l.stool_hardness ?? "", l.stool_color ?? "", l.stool_amount ?? ""].join(","),
                  );
                }
                const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "排便記録.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="mt-3 w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4 font-display text-base font-bold text-[var(--text)]"
            >
              ↓ 全記録をCSVで書き出す
            </button>
            <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <p className="text-center font-display text-base font-bold text-[var(--text)]">↑ CSVを取り込む</p>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="取り込むCSVファイルを選択"
                className="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-sm text-[var(--text)]"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  void (async () => {
                    try {
                      const text = await file.text();
                      const rows = parseStoolCsvText(text);
                      if (rows.length === 0) {
                        setImportMessage(
                          "読み取れる記録がありませんでした。選んだファイルがWAN'sのバックアップCSV（列：id・犬・排便日時・状態・色・量）か、ファイルの中身が空でないかをご確認ください。",
                        );
                        return;
                      }
                      const res = await api.importStoolCsv({ rows });
                      await queryClient.invalidateQueries({ queryKey: ["tracker"] });
                      setImportMessage(`取り込みました：${res.inserted}件を追加、${res.skipped}件はすでにあったためスキップしました。`);
                    } catch (err) {
                      const detail = err instanceof Error && err.message ? `（${err.message}）` : "";
                      setImportMessage(`取り込めませんでした。通信状態をご確認のうえ、もう一度お試しください。${detail}`);
                    }
                  })();
                }}
              />
              <p className="mt-3 text-sm text-[var(--dim)]">取り込むと記録が追加されます。すでに取り込み済みの記録は自動でスキップされるので、同じファイルを何度取り込んでも大丈夫です。</p>
              {importMessage && <p className="mt-2 text-sm font-medium text-[var(--text)]">{importMessage}</p>}
            </div>
          </section>
        )}

        {pet && (
          <>
            {/* Pet switcher */}
            <div className="grid grid-cols-2 gap-3" role="tablist" aria-label="ペットを選ぶ">
              {pets.map((p) => {
                const active = p.id === pet.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedPetId(p.id)}
                    className={`rounded-3xl border-2 p-4 text-left transition-colors ${
                      active
                        ? "border-[var(--accent)] bg-[var(--surface)]"
                        : "border-transparent bg-[var(--surface-alt)]"
                    }`}
                  >
                    <span
                      aria-hidden
                      className="flex h-12 w-12 items-center justify-center rounded-full font-display text-xl font-black text-white"
                      style={{ backgroundColor: active ? "var(--accent)" : "var(--sage)" }}
                    >
                      {p.name.slice(0, 1)}
                    </span>
                    <span className="mt-2 block font-display text-xl font-black text-[var(--text)]">{p.name}</span>
                    <span className="block text-sm text-[var(--dim)]">
                      {p.breed || "犬種 未入力"}・{p.age_years != null ? `${p.age_years}歳` : "年齢 未入力"}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Profile */}
            <section aria-label="基本情報" className="mt-5 rounded-3xl bg-[var(--surface)] p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-display text-lg font-bold text-[var(--text)]">基本情報</h2>
                <button type="button" onClick={() => setEditingProfile(true)} className="rounded-full border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--accent)]">
                  編集
                </button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <Field label="名前" value={pet.name} />
                <Field label="種類" value={pet.species} />
                <Field label="犬種" value={pet.breed} />
                <Field label="性別" value={pet.sex} />
                <Field label="年齢" value={pet.age_years != null ? `${pet.age_years}歳` : null} />
                <Field label="誕生日" value={pet.birth_date ? formatDate(pet.birth_date) : null} />
                <Field label="体重" value={pet.weight} />
                <Field label="病院" value={pet.vet_name} />
                <Field label="メモ" value={pet.notes} />
              </div>
            </section>

            {/* Upcoming */}
            <section aria-label="次回の予定" className="mt-5 rounded-3xl bg-[var(--accent-soft)] p-5">
              <h2 className="font-display text-lg font-bold text-[var(--text)]">次回の予定・目安</h2>
              {upcoming.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--dim)]">
                  まだ予定は登録されていません。各記録で「次回」の日付を入れると、ここに近い順で表示されます。
                </p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {upcoming.map((r) => {
                    const due = dueState(r.date_next, today);
                    return (
                      <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="font-display font-bold text-[var(--text)]">{formatDate(r.date_next)}</span>
                        <span className="text-sm text-[var(--text)]">
                          {SECTION_META[r.kind].title}：{r.title}
                        </span>
                        {due === "overdue" && <span className="rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-xs font-bold text-[var(--warn)]">期限を過ぎています</span>}
                        {due === "soon" && <span className="rounded-full bg-[var(--surface)] px-2 py-0.5 text-xs font-bold text-[var(--accent)]">もうすぐ</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Sections */}
            {KIND_ORDER.map((kind) => {
              const meta = SECTION_META[kind];
              const list = petRecords
                .filter((r) => r.kind === kind)
                .slice()
                .sort((a, b) => {
                  if (a.date_next && b.date_next) return a.date_next.localeCompare(b.date_next);
                  if (a.date_next) return -1;
                  if (b.date_next) return 1;
                  return (b.date_done ?? "").localeCompare(a.date_done ?? "");
                });
              return (
                <section key={kind} aria-label={meta.title} className="mt-8">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-display text-xl font-black text-[var(--text)]">
                      <span aria-hidden className="mr-2 inline-block h-3 w-3 rounded-full" style={{ backgroundColor: meta.accent }} />
                      {meta.title}
                    </h2>
                    <button
                      type="button"
                      onClick={() => setForm(emptyForm(kind))}
                      aria-label={`${pet.name}の${meta.addLabel}`}
                      className="shrink-0 rounded-full bg-[var(--accent)] px-4 py-2 font-display text-sm font-bold text-white"
                    >
                      ＋ 追加
                    </button>
                  </div>
                  {list.length === 0 ? (
                    <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--dim)]">
                      {meta.emptyText}
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-3">
                      {list.map((r) => (
                        <RecordCard key={r.id} record={r} today={today} onEdit={() => setForm(formFromRecord(r))} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </>
        )}
      </main>

      {logForm && pets.length > 0 && <DailyLogForm pets={pets} initial={logForm} onClose={() => setLogForm(null)} />}
      {pet && form && <RecordForm pet={pet} form={form} onClose={() => setForm(null)} />}
      {pet && editingProfile && <PetProfileForm pet={pet} onClose={() => setEditingProfile(false)} />}
    </div>
  );
}
