import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pets = sqliteTable("pets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  species: text("species").notNull().default("犬"),
  breed: text("breed").notNull().default(""),
  sex: text("sex"),
  ageYears: integer("age_years"),
  birthDate: text("birth_date"),
  weight: text("weight"),
  vetName: text("vet_name"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const dailyLogs = sqliteTable("daily_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  externalId: text("external_id"),
  petId: integer("pet_id")
    .notNull()
    .references(() => pets.id),
  logDate: text("log_date").notNull(),
  logTime: text("log_time"),
  category: text("category").notNull().default("うんち"),
  stoolHardness: text("stool_hardness"),
  stoolColor: text("stool_color"),
  stoolAmount: text("stool_amount"),
  detail: text("detail"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const records = sqliteTable("records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  petId: integer("pet_id")
    .notNull()
    .references(() => pets.id),
  kind: text("kind", {
    enum: ["vaccination", "health", "medication", "food"],
  }).notNull(),
  title: text("title").notNull(),
  category: text("category"),
  dateDone: text("date_done"),
  dateNext: text("date_next"),
  detail: text("detail"),
  status: text("status"),
  amount: text("amount"),
  memo: text("memo"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
