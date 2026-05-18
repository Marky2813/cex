import express from "express";
import { Heap } from 'heap-js';
import { string, z } from "zod/v4"; 
import bcrypt from "bcrypt";
import { prisma } from "./db";
import  jwt from "jsonwebtoken"
import { password } from "bun";
import { userInfo } from "node:os";
import { Status, Type, Side } from "./generated/prisma/enums";

const app = express();
app.use(express.json())
const saltrounds = 10; 

const authSchema = z.object({
  username:z.string().min(3), 
  password: z.string().min(6)
})

const instrumentSchema = z.object({
  name:z.string(), 
  symbol:z.string()
})

const orderSchema = z.object({
  userId:z.string(), 
  instrumentId:z.string(), 
  amount:z.number(),
  side:z.enum(Side), 
  type:z.enum(Type), 
  status:z.enum(Status), 
  totalQty:z.number().optional(), 
  filledQty:z.number().optional()
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


let BALANCES: Balances = {};
//how should balances look. 
/*
 BALANCES: {
    1: {
    "USD":{
      locked, total}
    }, 
    "SOL":{
      locked, total    
    }
 } 
*/

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
  // instrumentid: {
  // sell: {
  //   minHeap, minMap
  // },
  // buy: {
  //   maxHeap, maxMap
  // }
  // }
}

async function populateBalances() {
  //users, then their usd, then their balances. 
  const users = await prisma.user.findMany({
    include: {
      balance:true
    }
  });

    //every user has their specific assets and balance which we need to put in the BALANCES db. 
    for(const user of users) {
      BALANCES[user.id] =  {
        "USD": {
          locked:user.usdLock, 
          total:user.usdTotal
        }
      }
      for(const asset of user.balance) {
        BALANCES[user.id]![asset.instrumentSymbol] = {
          locked:asset.locked, 
          total:asset.total
        }
      }
    }
}

function authMiddleWare(req:express.Request, res:express.Response, next:express.NextFunction) {
    try {
    const token = req.header('token');
    console.log(token) 
    if(!token) {
      return res.status(400).send("token does not exist")
    }
    const result = jwt.verify(token, "hello123") as { username:string }; 
    if(!result) {
      return res.status(400).send("malformed token") 
    }
    console.log(result) 
    req.username = result.username; 
    //requests other than post do not have a body. what is the solution to this. 
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
    result.data.password = hash
    
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

app.post("/addinstrument", async (req, res) => {
    try {
    const result = instrumentSchema.safeParse(req.body);
    if(!result.success) {
      return res.status(400).json({
        error:result.error.message
      })
    }
    const instrument = await prisma.instrument.create({
      data: result.data
    })
    res.json({
      message:"Instrument Added", 
      instrument
    })
  } catch(err) {
    console.error(err);  
    return res.status(400).json({
      message:"error adding instrument", 
      err
    })
  }
})
app.post("/order",async (req, res) => {
//write -> read from in memory db and run matching engine -> write fills
  const order = orderSchema.safeParse(req.body); 
  if(!order.success) {
    return res.status(400).send(order.error.message); 
  }
  // check if the user has the usd to place the buy order. for this on load we need to populate the balances with the details of the user.
  const placedOrder = await prisma.order.create({
    data:order.data
  })
  res.json({
    message:"order added to the order db"
  })
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

app.put("/addusd/:amt", authMiddleWare, async (req,res) => {
      try {
      const amt:number = Number(req.params.amt);
      const result = await prisma.user.update({
        where: {
          username:req.username
        }, 
        data: {
          usdBal: {
            increment: amt
          }, 
          usdTotal: {
            increment: amt
          }, 
        }
      })
      res.json({
        message:"balance updated", 
        result
      })
    } catch(err) {
      console.error(err); 
      return res.status(400).json({
        err
      })
    } 
})

await populateBalances();
app.listen(3000, ()=> console.log(BALANCES))

