/*
  Warnings:

  - You are about to drop the column `usdTotl` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "usdTotl",
ADD COLUMN     "usdTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
