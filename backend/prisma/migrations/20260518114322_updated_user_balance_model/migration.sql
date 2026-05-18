/*
  Warnings:

  - You are about to drop the column `instrumentId` on the `UserBalance` table. All the data in the column will be lost.
  - Added the required column `instrumentSymbol` to the `UserBalance` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "UserBalance" DROP CONSTRAINT "UserBalance_instrumentId_fkey";

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "filledQty" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "UserBalance" DROP COLUMN "instrumentId",
ADD COLUMN     "instrumentSymbol" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "UserBalance" ADD CONSTRAINT "UserBalance_instrumentSymbol_fkey" FOREIGN KEY ("instrumentSymbol") REFERENCES "Instrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
