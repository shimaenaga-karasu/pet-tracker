import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";

const petShape = z.object({
  id: z.number(),
  name: z.string(),
  species: z.string(),
  breed: z.string(),
  sex: z.string().nullable(),
  age_years: z.number().nullable(),
  birth_date: z.string().nullable(),
  weight: z.string().nullable(),
  vet_name: z.string().nullable(),
  notes: z.string().nullable(),
});

const recordShape = z.object({
  id: z.number(),
  pet_id: z.number(),
  kind: z.enum(["vaccination", "health", "medication", "food"]),
  title: z.string(),
  category: z.string().nullable(),
  date_done: z.string().nullable(),
  date_next: z.string().nullable(),
  detail: z.string().nullable(),
  status: z.string().nullable(),
  amount: z.string().nullable(),
  memo: z.string().nullable(),
});

const dailyLogShape = z.object({
  id: z.number(),
  external_id: z.string().nullable(),
  pet_id: z.number(),
  log_date: z.string(),
  log_time: z.string().nullable(),
  category: z.string(),
  stool_hardness: z.string().nullable(),
  stool_color: z.string().nullable(),
  stool_amount: z.string().nullable(),
  detail: z.string().nullable(),
});

const trackerResponse = z.object({
  pets: z.array(petShape),
  records: z.array(recordShape),
  daily_logs: z.array(dailyLogShape),
});

type TrackerResponse = z.infer<typeof trackerResponse>;

const KNOWN_PETS = [
  { name: "おはぎ", species: "犬", breed: "トイプードル", sex: "メス", ageYears: 8, sortOrder: 0 },
  { name: "サナ", species: "犬", breed: "ラブラドール・レトリーバー", sex: "メス", ageYears: 2, sortOrder: 1 },
] as const;

async function loadTracker(ctx: Ctx): Promise<TrackerResponse> {
  const db = ctx.db<typeof schema>();
  const petRows = await db.select().from(schema.pets).orderBy(asc(schema.pets.sortOrder), asc(schema.pets.id));
  const recordRows = await db.select().from(schema.records).orderBy(asc(schema.records.id));
  const logRows = await db.select().from(schema.dailyLogs).orderBy(asc(schema.dailyLogs.id));
  return {
    daily_logs: logRows.map((l) => ({
      id: l.id,
      external_id: l.externalId ?? null,
      pet_id: l.petId,
      log_date: l.logDate,
      log_time: l.logTime ?? null,
      category: l.category,
      stool_hardness: l.stoolHardness ?? null,
      stool_color: l.stoolColor ?? null,
      stool_amount: l.stoolAmount ?? null,
      detail: l.detail ?? null,
    })),
    pets: petRows.map((p) => ({
      id: p.id,
      name: p.name,
      species: p.species,
      breed: p.breed,
      sex: p.sex ?? null,
      age_years: p.ageYears ?? null,
      birth_date: p.birthDate ?? null,
      weight: p.weight ?? null,
      vet_name: p.vetName ?? null,
      notes: p.notes ?? null,
    })),
    records: recordRows.map((r) => ({
      id: r.id,
      pet_id: r.petId,
      kind: r.kind,
      title: r.title,
      category: r.category ?? null,
      date_done: r.dateDone ?? null,
      date_next: r.dateNext ?? null,
      detail: r.detail ?? null,
      status: r.status ?? null,
      amount: r.amount ?? null,
      memo: r.memo ?? null,
    })),
  };
}

const okResponse = z.object({ ok: z.literal(true) });

// --- WAN's backup CSV parsing (shared by importStoolCsv / importBackupCsv) ---

// The real WAN's 💩管理カレンダー backup file is BOM-prefixed, CRLF, and
// quotes EVERY field, header included:
//   "id","犬","排便日時","状態","色","量"
//   "676756a7-...","おはぎ","2026-11-09T00:31","硬い","茶色","普通"
// A naive split(",") leaves the quotes on every value, so nothing matches.
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

// Deterministic stand-in ID for CSV rows that carry no ID — identical
// algorithm to the client's, so a row gets the same ID on either path and
// re-importing the same file dedupes instead of doubling records.
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

type ParsedStoolRow = {
  externalId: string;
  petName: string;
  logDate: string;
  logTime: string;
  hardness: string;
  color: string;
  amount: string;
};

// Parses WAN's backup CSV text into normalized stool rows. Columns are
// located by header NAME (id, 犬, 排便日時, 状態, 色, 量) when a header row is
// present; otherwise falls back to the positional layouts (with or without
// a leading id column). Datetimes may be "2026-11-09T00:31" or
// "2026-11-09 00:31". Rows for unknown pets are left in the result and
// counted as skipped by the inserter.
function parseStoolCsvText(text: string): ParsedStoolRow[] {
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
  const out: ParsedStoolRow[] = [];
  for (let r = byHeader ? 1 : 0; r < table.length; r++) {
    const cols = table[r] ?? [];
    let externalId = "";
    let petName = "";
    let datetime = "";
    let hardness = "";
    let color = "";
    let amount = "";
    if (idx) {
      externalId = at(cols, idx.id);
      petName = at(cols, idx.pet);
      datetime = at(cols, idx.dt);
      hardness = at(cols, idx.hardness);
      color = at(cols, idx.color);
      amount = at(cols, idx.amount);
    } else if (cols.length >= 6 && isDateTime(cols[2] ?? "")) {
      externalId = cols[0] ?? "";
      petName = cols[1] ?? "";
      datetime = cols[2] ?? "";
      hardness = cols[3] ?? "";
      color = cols[4] ?? "";
      amount = cols[5] ?? "";
    } else if (cols.length >= 5 && isDateTime(cols[1] ?? "")) {
      petName = cols[0] ?? "";
      datetime = cols[1] ?? "";
      hardness = cols[2] ?? "";
      color = cols[3] ?? "";
      amount = cols[4] ?? "";
    } else {
      continue;
    }
    if (!petName || !isDateTime(datetime)) continue;
    const normalized = datetime.replace(" ", "T").slice(0, 16);
    const logDate = normalized.slice(0, 10);
    const logTime = normalized.slice(11, 16);
    if (!externalId) {
      externalId = syntheticCsvId(`${petName}|${normalized}|${hardness}|${color}|${amount}`);
    }
    out.push({ externalId, petName, logDate, logTime, hardness, color, amount });
  }
  return out;
}

// Inserts parsed stool rows, skipping (a) rows whose external id already
// exists and (b) rows whose content (pet, date, time, hardness, color,
// amount) matches a stool log already in the tracker under a different id
// — e.g. a record first typed in by hand or reported in chat, later backed
// up by WAN's. Rows naming an unknown pet are skipped too.
async function insertStoolRows(
  ctx: Ctx,
  rows: ParsedStoolRow[],
): Promise<{ inserted: number; skipped: number }> {
  const db = ctx.db<typeof schema>();
  const pets = await db.select().from(schema.pets);
  const byName = new Map(pets.map((p) => [p.name, p.id]));
  const existing = await db.select().from(schema.dailyLogs);
  const existingIds = new Set(existing.map((l) => l.externalId).filter(Boolean));
  const contentKey = (
    petId: number,
    logDate: string,
    logTime: string | null,
    hardness: string | null,
    color: string | null,
    amount: string | null,
  ) => `${petId}|${logDate}|${logTime ?? ""}|${hardness ?? ""}|${color ?? ""}|${amount ?? ""}`;
  const existingKeys = new Set(
    existing
      .filter((l) => l.category === "うんち")
      .map((l) => contentKey(l.petId, l.logDate, l.logTime, l.stoolHardness, l.stoolColor, l.stoolAmount)),
  );
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const petId = byName.get(row.petName);
    if (petId == null || existingIds.has(row.externalId)) {
      skipped++;
      continue;
    }
    const key = contentKey(petId, row.logDate, row.logTime, row.hardness || null, row.color || null, row.amount || null);
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    await db.insert(schema.dailyLogs).values({
      externalId: row.externalId,
      petId,
      logDate: row.logDate,
      logTime: row.logTime,
      category: "うんち",
      stoolHardness: row.hardness || null,
      stoolColor: row.color || null,
      stoolAmount: row.amount || null,
    });
    existingIds.add(row.externalId);
    existingKeys.add(key);
    inserted++;
  }
  if (inserted > 0) ctx.invalidateQueries();
  return { inserted, skipped };
}

export const Actions = {
  seedPets: defineAction({
    description: "Registers the two known dogs (おはぎ and サナ) and the three user-provided stool records for 2026-11-09, once only; also fills in each dog's sex (メス) when it is not yet recorded.",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.pets);
      if (existing.length === 0) {
        for (const pet of KNOWN_PETS) {
          await db.insert(schema.pets).values({
            name: pet.name,
            species: pet.species,
            breed: pet.breed,
            sex: pet.sex,
            ageYears: pet.ageYears,
            sortOrder: pet.sortOrder,
          });
        }
      } else {
        // Fill in sex for the two known dogs only where it is still empty.
        for (const pet of KNOWN_PETS) {
          const row = existing.find((p) => p.name === pet.name);
          if (row && (row.sex == null || row.sex === "")) {
            await db.update(schema.pets).set({ sex: pet.sex }).where(eq(schema.pets.id, row.id));
          }
        }
      }
      const petsNow = await db.select().from(schema.pets);
      const byName = new Map(petsNow.map((p) => [p.name, p.id]));
      const existingLogs = await db.select().from(schema.dailyLogs);
      const existingExternalIds = new Set(existingLogs.map((l) => l.externalId).filter(Boolean));
      // Exact rows from the user's backup file (id, 犬, 排便日時, 状態, 色, 量).
      const seedLogs = [
        { externalId: "676756a7-8878-4dea-920f-ee7311b87912", pet: "おはぎ", time: "00:31", hardness: "硬い", color: "茶色", amount: "普通" },
        { externalId: "1907eeb4-bcd3-4d1c-beff-0eceee79e94a", pet: "サナ", time: "05:33", hardness: "普通", color: "茶色", amount: "普通" },
        { externalId: "bee0cd46-dfd8-4bb5-a008-39bb280af5ae", pet: "おはぎ", time: "13:40", hardness: "硬い", color: "茶色", amount: "少量" },
      ] as const;
      for (const log of seedLogs) {
        if (existingExternalIds.has(log.externalId)) continue;
        const petId = byName.get(log.pet);
        if (petId == null) continue;
        await db.insert(schema.dailyLogs).values({
          externalId: log.externalId,
          petId,
          logDate: "2026-11-09",
          logTime: log.time,
          category: "うんち",
          stoolHardness: log.hardness,
          stoolColor: log.color,
          stoolAmount: log.amount,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getTracker: defineAction({
    description: "Returns all pets and all of their vaccination, health, medication, and food records.",
    request: z.object({}),
    response: trackerResponse,
    async handler(ctx): Promise<TrackerResponse> {
      return loadTracker(ctx);
    },
  }),

  updatePet: defineAction({
    description: "Updates one pet's profile fields such as sex, age, birth date, weight, vet, and notes.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(60),
      breed: z.string().max(80),
      sex: z.string().max(20).nullable(),
      age_years: z.number().int().min(0).max(40).nullable(),
      birth_date: z.string().max(10).nullable(),
      weight: z.string().max(40).nullable(),
      vet_name: z.string().max(120).nullable(),
      notes: z.string().max(1000).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.pets)
        .set({
          name: args.name,
          breed: args.breed,
          sex: args.sex,
          ageYears: args.age_years,
          birthDate: args.birth_date,
          weight: args.weight,
          vetName: args.vet_name,
          notes: args.notes,
        })
        .where(eq(schema.pets.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  saveRecord: defineAction({
    description: "Creates or updates one vaccination, health, medication-cycle, or food record for a pet.",
    request: z.object({
      id: z.number().int().positive().nullable(),
      pet_id: z.number().int().positive(),
      kind: z.enum(["vaccination", "health", "medication", "food"]),
      title: z.string().min(1).max(120),
      category: z.string().max(60).nullable(),
      date_done: z.string().max(10).nullable(),
      date_next: z.string().max(10).nullable(),
      detail: z.string().max(500).nullable(),
      status: z.string().max(60).nullable(),
      amount: z.string().max(120).nullable(),
      memo: z.string().max(1000).nullable(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        petId: args.pet_id,
        kind: args.kind,
        title: args.title,
        category: args.category,
        dateDone: args.date_done,
        dateNext: args.date_next,
        detail: args.detail,
        status: args.status,
        amount: args.amount,
        memo: args.memo,
      };
      if (args.id != null) {
        await db
          .update(schema.records)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.records.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db.insert(schema.records).values(values).returning({ id: schema.records.id });
      const inserted = result[0];
      if (!inserted) throw new Error("saveRecord: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  saveDailyLog: defineAction({
    description: "Creates or updates one daily care log entry (time, category, stool condition, and notes) for a pet on a given date.",
    request: z.object({
      id: z.number().int().positive().nullable(),
      pet_id: z.number().int().positive(),
      log_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      log_time: z.string().max(5).nullable(),
      category: z.string().min(1).max(30),
      stool_hardness: z.string().max(30).nullable(),
      stool_color: z.string().max(30).nullable(),
      stool_amount: z.string().max(30).nullable(),
      detail: z.string().max(1000).nullable(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const isStool = args.category === "うんち";
      const values = {
        petId: args.pet_id,
        logDate: args.log_date,
        logTime: args.log_time,
        category: args.category,
        stoolHardness: isStool ? args.stool_hardness : null,
        stoolColor: isStool ? args.stool_color : null,
        stoolAmount: isStool ? args.stool_amount : null,
        detail: args.detail,
      };
      if (args.id != null) {
        await db
          .update(schema.dailyLogs)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.dailyLogs.id, args.id));
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const result = await db
        .insert(schema.dailyLogs)
        .values({ ...values, externalId: crypto.randomUUID() })
        .returning({ id: schema.dailyLogs.id });
      const inserted = result[0];
      if (!inserted) throw new Error("saveDailyLog: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  importStoolCsv: defineAction({
    description: "Imports stool records in the backup CSV format (id, 犬, 排便日時, 状態, 色, 量), skipping any record whose id — or whose pet/date/time/condition content — already exists in the tracker.",
    request: z.object({
      rows: z
        .array(
          z.object({
            external_id: z.string().min(1).max(100),
            pet_name: z.string().min(1).max(60),
            datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
            hardness: z.string().max(30),
            color: z.string().max(30),
            amount: z.string().max(30),
          }),
        )
        .max(1000),
    }),
    response: z.object({ inserted: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      return insertStoolRows(
        ctx,
        args.rows.map((row) => ({
          externalId: row.external_id,
          petName: row.pet_name,
          logDate: row.datetime.slice(0, 10),
          logTime: row.datetime.slice(11, 16),
          hardness: row.hardness,
          color: row.color,
          amount: row.amount,
        })),
      );
    },
  }),

  importBackupCsv: defineAction({
    description: "Imports the raw text of a WAN's 💩管理カレンダー backup CSV file (BOM and fully-quoted fields accepted), skipping records already in the tracker by id or by matching pet, date, time, and stool condition.",
    request: z.object({
      csv_text: z.string().min(1).max(2_000_000),
    }),
    response: z.object({ inserted: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      return insertStoolRows(ctx, parseStoolCsvText(args.csv_text));
    },
  }),

  deleteDailyLog: defineAction({
    description: "Deletes one daily care log entry.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.dailyLogs).where(eq(schema.dailyLogs.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteRecord: defineAction({
    description: "Deletes one record entry for a pet.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.records).where(eq(schema.records.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
