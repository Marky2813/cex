import express from "express";
import { Heap } from 'heap-js';
import { string, symbol, z } from "zod/v4"; 
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
  // userId:z.string(),
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

type Order = {
  orderId: string,
  userId: string,
  qty: number
}

type Bid = {
  maxHeap: Heap<number>, 
  maxMap: Map<number, Order[]>
}

type Ask = {
  minHeap: Heap<number>, 
  minMap: Map<number, Order[]>
}

type InstrumentOrders = {
  buy: Bid, 
  sell: Ask
}

type OrderBook = {
  [symbol:string]:InstrumentOrders
}

const orderBook:OrderBook = {
}

function orderBookInit(symbol:string) {
  orderBook[symbol] = {
    buy: {
      maxHeap: new Heap(Heap.maxComparatorNumber),
      maxMap: new Map<number, Order[]>()
    }, 
    sell: {
      minHeap: new Heap(Heap.minComparatorNumber), 
      minMap: new Map<number, Order[]>()
    }
  }
}

async function populateOrderBook() {
  const orders = await prisma.order.findMany({
    include: {
      instrument:true 
    },
    where: {
      status: {
        in:["Pending", "Partial"]
      }
    }
  })
  // if the order type is market. then can it ever be pending or partial in the database ?
  for(const order of orders) {
    if(!Object.hasOwn(orderBook, order.instrument.symbol)){
    orderBookInit(order.instrument.symbol);
    }
    if(order.type == "Limit") {
      const symOrderBook = orderBook[order.instrument.symbol]
      if(order.side == "Buy") {
        //add the order to the orderBook in the heap and the map.
        //while using the bracket notation to access object elements. Typescripts verifies if the key(string literal) exists. now after we  chain them here it fails to verify the same.
        if(!symOrderBook?.buy.maxMap.has(order.amount)) { 
        symOrderBook?.buy.maxHeap.heapArray.push(order.amount);
        symOrderBook?.buy.maxMap.set(order.amount, [{
              orderId: order.id, 
              userId: order.userId,  
              qty: order.totalQty!
            }])
      } else {
        //since we share the references of the objects and the arrays. we need not set it again 
        symOrderBook?.buy.maxMap.get(order.amount)?.push(
          {
              orderId: order.id, 
              userId: order.userId,  
              qty: order.totalQty!
            }
        )
      }
      } else {
        //sell side
        if(!symOrderBook?.sell.minMap.has(order.amount)) { 
        symOrderBook?.sell.minHeap.heapArray.push(order.amount);
        symOrderBook?.sell.minMap.set(order.amount, [{
              orderId: order.id, 
              userId: order.userId,  
              qty: order.totalQty!
            }])
      } else {
        //since we share the references of the objects and the arrays. we need not set it again 
        symOrderBook?.sell.minMap.get(order.amount)?.push(
          {
              orderId: order.id, 
              userId: order.userId,  
              qty: order.totalQty!
            }
        )
      }
      }
    }
  }
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
    orderBookInit(result.data.symbol)
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
app.post("/order", authMiddleWare, async (req, res) => {
//write -> read from in memory db and run matching engine -> write fills
  let order = orderSchema.safeParse(req.body); 
  if(!order.success) {
    return res.status(400).send(order.error.message); 
  }
  const user = await prisma.user.findUnique({
    where: {
      username: req.username
    }, 
    select: {
      id:true
    }
  })
  if(!user) {
    return res.status(500).send("internal server error ")
  }
  
  // check if the user has sufficient usd to place bid
  // if(BALANCES[order.data.userId]!["USD"]!.total < order.data.amount * order.data.totalQty!) {
  //   return res.status(400).json({
  //     message:"You don't have sufficient to place bid"
  //   })
  // }
  
  const placedOrder = await prisma.order.create({
    data: {
      ...order.data, userId: user.id
    }
  })

  //matching begins for the buy order. write uska logic here. 
  
  //since it is a buy limit order. we need to check the sales heap.
  
  //orderbook -> instrument -> sales discover karni hai 

  // orderBook[order.data.instrumentId][sell][minHeap].peek()
  /*
  if(Number(Object.keys(minHeap.peek())[0]) <= order.data.amount) {
    while(filled == total) {
    //it's not a sinlgle order. it can be multiple orders at the same price by different people 
    const ask = minHeap.peek();
    if(ask[value].qty <= order.data.totalQty) {
      //usd kam zada bhi karna hai 
      order.data.filledQty = order.data.filledQty+ask[value].qty
      ask[value].qty = order.data.totalQty -ask[value].qty; 
      minHeap.pop() //remove the order from the order book
    } else {
      ask[value].qty = ask[value].qty - totalQty - filledQty;
      //make usd exchange
    }
  }
    //buy right away. 
  }
  
  */
  res.json({
    message:"order added to the order db", 
    placedOrder
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
await populateOrderBook();
app.listen(3000, ()=> {
  console.dir(orderBook, { depth: null })
})

