import express from "express";
import { Heap } from 'heap-js';
import { z } from "zod/v4"; 
import bcrypt from "bcrypt";
import { prisma } from "./db";
import  jwt from "jsonwebtoken"
import { password } from "bun";
import { userInfo } from "node:os";

const app = express();
app.use(express.json())
const saltrounds = 10; 

const authSchema = z.object({
  username:z.string().min(3), 
  password: z.string().min(6)
})

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

function authMiddleWare(req:express.Request, res:express.Response, next:express.NextFunction) {
    try {
    const token = req.body.token; 
    if(!token) {
      return res.status(400).send("token does not exist")
    }
    const result = jwt.verify(token, "hello123") as { username:string }; 
    if(!result) {
      return res.status(400).send("malformed token") 
    } 
    req.body.username = result.username; 
    next();
    } catch(err) {
      console.error("error verifying token", err)
      return res.status(400).send("Unauthorized");
    }
}

//--- Auth --- 
app.post("/signup", async (req, res) => {
    const result = authSchema.safeParse(req.body); 
    if(!result.success) {
      return res.status(400).json({
        error:result.error.message
      })
    }
    const usernameExists = await prisma.user.findUnique({
      where: {
        username: result.data.username
      }
    })
    if(usernameExists) {
      return res.status(400).json({
        message:"Username already exists"
      })
    }
    //if it doesn't exist we need to hash the pasword and then add it to the users table. 
    const hash = await bcrypt.hash(result.data.password, saltrounds);
    
    const user = await prisma.user.create({
      data:result.data
    })

    if(!user) {
      res.status(500).json({
        message: "Unable to create user"
      })
    }

    return res.json({
      message:"signed up successfully", 
      data:user 
    })
})

app.post("/signin", async (req, res) => {
  const result = authSchema.safeParse(req.body); 
  if(!result.success) {
      return res.status(400).json({
        error:result.error.message
      })
    }
  const usernameExists = await prisma.user.findUnique({
    where: {
      username: result.data.username 
    }
  })
  if(!usernameExists) {
    return res.status(400).json({
      message:"username does not exist"
    })
  }
  const passwordCorrect = await bcrypt.compare(result.data.password, usernameExists?.password)
  if(!passwordCorrect) {
    return res.status(400).json({
      message:"incorrect password"
    })
  }
  const token = jwt.sign({
    username:usernameExists.username
  }, "hello123")

  return res.json({
    message:"signed in successfully", 
    token
  })
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

