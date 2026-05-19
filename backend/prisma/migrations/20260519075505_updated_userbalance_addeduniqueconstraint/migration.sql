/*
  Warnings:

  - A unique constraint covering the columns `[userId,instrumentSymbol]` on the table `UserBalance` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "UserBalance_userId_instrumentSymbol_key" ON "UserBalance"("userId", "instrumentSymbol");
