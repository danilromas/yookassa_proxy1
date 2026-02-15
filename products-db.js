import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("DATABASE_URL is not set. Products API will return 503.");
}

export const sql = connectionString ? neon(connectionString) : null;

function rowToProduct(row) {
  return {
    id: row.id,
    title: row.title,
    price: typeof row.price === "string" ? parseFloat(row.price) : row.price,
    description: row.description,
    image: row.image,
    fullDescription: row.full_description ?? undefined,
    inStock: row.in_stock,
    category: row.category ?? undefined,
    isGlass: row.is_glass ?? false,
    isUnbreakable: row.is_unbreakable ?? false,
  };
}

export function bodyToRow(body) {
  return {
    title: String(body?.title ?? ""),
    price: Number(body?.price) || 0,
    description: String(body?.description ?? ""),
    image: String(body?.image ?? ""),
    full_description: body?.fullDescription != null ? String(body.fullDescription) : null,
    in_stock: Boolean(body?.inStock),
    category: body?.category != null ? String(body.category) : null,
    is_glass: body?.isGlass != null ? Boolean(body.isGlass) : null,
    is_unbreakable: body?.isUnbreakable != null ? Boolean(body.isUnbreakable) : null,
  };
}

export { rowToProduct };
