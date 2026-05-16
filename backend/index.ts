import express from "express";
import { Heap } from 'heap-js';

const app = express();
app.use(express.json())

type AssetBalance = {
  total: number,
  locked: number
}

type UserBalance = {
  [symbol: string]: AssetBalance
}

type Balances = {
  [userId: string]: UserBalance
}

const BALANCES: Balances = {
}

type OrderStatus = "pending" | "partial";

type Order = {
  orderId: string,
  userId: string,
  orderStatus: OrderStatus,
  qty: number,
  amount: number
}
type Node = {
  price: number,
  orders: Order[]
}
const customPriorityComparatorMin = (a: Node, b: Node) => a.price - b.price;
const minHeap = new Heap(customPriorityComparatorMin);
const minMap = new Map<number, Order[]>();

const customPriorityComparatorMax = (a: Node, b: Node) => b.price - a.price;
const maxHeap = new Heap(customPriorityComparatorMax);
const maxMap = new Map<number, Order[]>();


const orderBooks = {
  sell: {
    minHeap, minMap
  },
  buy: {
    maxHeap, maxMap
  }
}

//--- Auth --- 
app.post("/signup", (req, res) => {

})

app.post("/signin", (req, res) => {

})

app.post("/order",(req, res) => {
//write -> read from in memory db and run matching engine -> write fills
})

app.delete("/order/:orderId", (req, res) => {

})

app.get("/orders", (req, res) => {

})

app.get("/orderbook/:symbol", (req, res) => {

})

app.get("/fills/:symbol", (req, res) => {

})

app.get("stocks", (req, res) => {

})

app.get("balance", (req, res) => {

})

app.listen(3000, ()=> console.log("CEX running on :3000"))

