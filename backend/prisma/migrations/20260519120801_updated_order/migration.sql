/*
  Warnings:

  - Made the column `filledQty` on table `Order` required. This step will fail if there are existing NULL values in that column.
  - Made the column `totalQty` on table `Order` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "instrumentSymbol" TEXT NOT NULL DEFAULT 'SOL',
ALTER COLUMN "filledQty" SET NOT NULL,
ALTER COLUMN "totalQty" SET NOT NULL,
ALTER COLUMN "totalQty" SET DEFAULT 0;
