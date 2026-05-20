import express from "express";
import { Heap } from 'heap-js';
import { string, symbol, z } from "zod/v4";
import bcrypt from "bcrypt";
import { prisma } from "./db";
import jwt from "jsonwebtoken"
import { password } from "bun";
import { userInfo } from "node:os";
import { Status, Type, Side } from "./generated/prisma/enums";

const app = express();
app.use(express.json())
const saltrounds = 10;

const authSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6)
})

const instrumentSchema = z.object({
  name: z.string(),
  symbol: z.string()
})

const orderSchema = z.object({
  // userId:z.string(),
  instrumentId: z.string(),
  instrumentSymbol:z.string(),
  amount: z.number(),
  side: z.enum(Side),
  type: z.enum(Type),
  status: z.enum(Status),
  totalQty: z.number().optional(),
  filledQty: z.number().default(0)
})

const depositSchema = z.object({
  instrumentSymbol:z.string(), 
  qty:z.number()
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
  availqty: number, 
  spqty:number,
  status: string
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
  [symbol: string]: InstrumentOrders
}

const orderBook: OrderBook = {
}

const fills:any = []

function orderBookInit(symbol: string) {
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
      instrument: true
    },
    where: {
      status: {
        in: ["Pending", "Partial"]
      }
    }
  })
  // if the order type is market. then can it ever be pending or partial in the database ?
  for (const order of orders) {
    if (!Object.hasOwn(orderBook, order.instrument.symbol)) {
      orderBookInit(order.instrument.symbol);
    }
    if (order.type == "Limit") {
      const symOrderBook = orderBook[order.instrument.symbol]
      if (order.side == "Buy") {
        //add the order to the orderBook in the heap and the map.
        //while using the bracket notation to access object elements. Typescripts verifies if the key(string literal) exists. now after we  chain them here it fails to verify the same.
        if (!symOrderBook?.buy.maxMap.has(order.amount)) {
          symOrderBook?.buy.maxHeap.heapArray.push(order.amount);
          symOrderBook?.buy.maxMap.set(order.amount, [{
            orderId: order.id,
            userId: order.userId,
            availqty: order.totalQty! - order.filledQty!,
            spqty:0, 
            status: order.status
          }])
        } else {
          //since we share the references of the objects and the arrays. we need not set it again 
          symOrderBook?.buy.maxMap.get(order.amount)?.push(
            {
              orderId: order.id,
              userId: order.userId,
              availqty: order.totalQty! - order.filledQty!,
              spqty:0,
              status:order.status
            }
          )
        }
      } else {
        //sell side
        if (!symOrderBook?.sell.minMap.has(order.amount)) {
          symOrderBook?.sell.minHeap.heapArray.push(order.amount);
          symOrderBook?.sell.minMap.set(order.amount, [{
            orderId: order.id,
            userId: order.userId,
            availqty: order.totalQty! - order.filledQty!,
            spqty:0,
            status:order.status
          }])
        } else {
          //since we share the references of the objects and the arrays. we need not set it again 
          symOrderBook?.sell.minMap.get(order.amount)?.push(
            {
              orderId: order.id,
              userId: order.userId,
              availqty: order.totalQty! - order.filledQty!,
              spqty:0,
              status:order.status
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
      balance: true
    }
  });

  //every user has their specific assets and balance which we need to put in the BALANCES db. 
  for (const user of users) {
    BALANCES[user.id] = {
      "USD": {
        locked: user.usdLock,
        total: user.usdTotal
      }
    }
    for (const asset of user.balance) {
      BALANCES[user.id]![asset.instrumentSymbol] = {
        locked: asset.locked,
        total: asset.total
      }
    }
  }
}

function authMiddleWare(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = req.header('token');
    if (!token) {
      return res.status(400).send("token does not exist")
    }
    const result = jwt.verify(token, "hello123") as { username: string };
    if (!result) {
      return res.status(400).send("malformed token")
    }
    req.username = result.username;
    //requests other than post do not have a body. what is the solution to this. 
    next();
  } catch (err) {
    console.error("error verifying token", err)
    return res.status(400).send("Unauthorized");
  }
}

//--- Auth --- 
app.post("/signup", async (req, res) => {
  const result = authSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: result.error.message
    })
  }
  const usernameExists = await prisma.user.findUnique({
    where: {
      username: result.data.username
    }
  })
  if (usernameExists) {
    return res.status(400).json({
      message: "Username already exists"
    })
  }
  //if it doesn't exist we need to hash the pasword and then add it to the users table. 
  const hash = await bcrypt.hash(result.data.password, saltrounds);
  result.data.password = hash

  const user = await prisma.user.create({
    data: result.data
  })

  if (!user) {
    res.status(500).json({
      message: "Unable to create user"
    })
  }

  return res.json({
    message: "signed up successfully",
    data: user
  })
})

app.post("/signin", async (req, res) => {
  const result = authSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({
      error: result.error.message
    })
  }
  const usernameExists = await prisma.user.findUnique({
    where: {
      username: result.data.username
    }
  })
  if (!usernameExists) {
    return res.status(400).json({
      message: "username does not exist"
    })
  }
  const passwordCorrect = await bcrypt.compare(result.data.password, usernameExists?.password)
  if (!passwordCorrect) {
    return res.status(400).json({
      message: "incorrect password"
    })
  }
  const token = jwt.sign({
    username: usernameExists.username
  }, "hello123")

  return res.json({
    message: "signed in successfully",
    token
  })
})

app.post("/addinstrument", async (req, res) => {
  try {
    const result = instrumentSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: result.error.message
      })
    }
    const instrument = await prisma.instrument.create({
      data: result.data
    })
    orderBookInit(result.data.symbol)
    res.json({
      message: "Instrument Added",
      instrument
    })
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      message: "error adding instrument",
      err
    })
  }
})

app.post("/deposit", authMiddleWare, async (req, res) => {
    const deposit = depositSchema.safeParse(req.body);
    if(!deposit.success) {
      return res.status(400).json({
        error:deposit.error.message
      })
    }
    const user = await prisma.user.findUnique({
    where: {
      username: req.username
    },
    select: {
      id: true
    }
  })
  if (!user) {
    return res.status(500).send("internal server error ")
  }
  if(!Object.hasOwn(BALANCES[user.id]!, deposit.data!.instrumentSymbol)) {
    //make a post request 
    const deposited = await prisma.userBalance.create({
      data: {
        userId:user.id, 
        instrumentSymbol:deposit.data!.instrumentSymbol, 
        total:deposit.data?.qty
      }
    })
    await populateBalances();
    console.log(BALANCES)
    return res.json({
        message:"deposited", 
        deposited
    })
  } else {
    //make a update request because user already has some balance of that specific instrument 
    const deposited = await prisma.userBalance.update({
      where: {
        userId_instrumentSymbol:{
        instrumentSymbol:deposit.data.instrumentSymbol, 
        userId: user.id
        }
      }, 
      data: {
        total: {
          increment:deposit.data.qty
        }
      }
    })
    await populateBalances();
    console.log(BALANCES)
    return res.json({
        message:"deposited", 
        deposited
    })
  }
})

app.post("/order", authMiddleWare, async (req, res) => {
  //write -> read from in memory db and run matching engine -> write fills
  let order = orderSchema.safeParse(req.body);
  if (!order.success) {
    return res.status(400).send(order.error.message);
  }
  const user = await prisma.user.findUnique({
    where: {
      username: req.username
    },
    select: {
      id: true
    }
  })
  if (!user) {
    return res.status(500).send("internal server error")
  }

  // for a buy order: check if the user has sufficient usd to place bid
  if(BALANCES[user.id]!["USD"]!.total < order.data.amount * order.data.totalQty!) {
    return res.status(400).json({
      message:"You don't have sufficient to place bid"
    })
  }
  BALANCES[user.id]!["USD"]!.locked = order.data.amount * order.data.totalQty!;
  //for a sell order we need to check if the user has enough instrument balance. 

  const placedOrder = await prisma.order.create({
    data: {
      ...order.data, userId: user.id
    }
  })

  //matching begins for the buy order. write uska logic here. 
  //since it is a buy limit order. we need to check the sales heap.
  let ask = orderBook[order.data.instrumentSymbol]?.sell;
  if(Number(ask!.minHeap.peek()) <= order.data.amount) {
    
    while(order.data.filledQty! < order.data.totalQty!) {
      let sellorders = ask!.minMap.get(ask!.minHeap.peek()!)!
      let sellorder = sellorders.shift()!;
      let filledQty = Math.min(sellorder.availqty-sellorder.spqty, order.data.totalQty!-order.data.filledQty!);
      let usdMoved = filledQty * order.data.amount; 
      sellorder.spqty = sellorder.spqty + filledQty;
      order.data.filledQty = order.data.filledQty! + filledQty;
      BALANCES[user.id]!.USD!.locked = BALANCES[user.id]!.USD!.locked - usdMoved;
      BALANCES[user.id]!.USD!.total = BALANCES[user.id]!.USD!.total - usdMoved;
      if(BALANCES[user.id]![order.data.instrumentSymbol]) {
        BALANCES[user.id]![order.data.instrumentSymbol]!.total += filledQty; 
      } else {
        BALANCES[user.id]![order.data.instrumentSymbol] = {
          total: filledQty, 
          locked: 0
        }
      }
      BALANCES[sellorder.userId]!.USD!.total = BALANCES[sellorder.userId]!.USD!.total + usdMoved;
      BALANCES[sellorder.userId]![order.data.instrumentSymbol]!.locked -= filledQty;
      BALANCES[sellorder.userId]![order.data.instrumentSymbol]!.total -= filledQty;
      const fillQty = filledQty;
      if(sellorder.availqty - sellorder.spqty == 0) {
        sellorder.status = "Completed"
        fills.push({...sellorder, fillQty})
        if(sellorders.length == 0) {
          ask!.minMap.delete(ask!.minHeap.peek()!);
          ask!.minHeap.pop()
          if(!(Number(ask!.minHeap.peek()) <= order.data.amount)) break; 
        }
      } else {
        sellorder.status = "Partial"
        fills.push({...sellorder, fillQty})
        sellorders.unshift(sellorder)
      }
      if(!ask?.minHeap.peek()) break;
    }
    //time to create a tranasaction.
     if(order.data.filledQty! == order.data.totalQty!) order.data.status = "Completed";
     else order.data.status = "Partial" 
    await prisma.$transaction([prisma.user.update({
      where:{
        id:user.id
      },
      data: {
        usdBal: BALANCES[user.id]!.USD!.total,
        usdTotal: BALANCES[user.id]!.USD!.total, 
        usdLock: BALANCES[user.id]!.USD!.locked
      }
    }), prisma.order.update({
      where: {
        id:placedOrder.id
      }, data: {
        status: order.data.status,
        filledQty:order.data.filledQty
      }
    }), prisma.userBalance.upsert({
      where:{
        userId_instrumentSymbol:{
          userId:placedOrder.id, 
          instrumentSymbol:placedOrder.instrumentSymbol
        }
      }, 
      update:{
        total:BALANCES[user.id]![order.data.instrumentSymbol]!.total
      }, 
      create:{
        userId:placedOrder.userId, 
        instrumentSymbol:placedOrder.instrumentSymbol, 
        locked: 0, 
        total:BALANCES[user.id]![order.data.instrumentSymbol]!.total
      }
    }),...fills.map(fill => prisma.fill.create({
       data: {
        buyOrderId:placedOrder.id, 
        sellOrderId:fill.orderId, 
        instrumentId:placedOrder.instrumentId, 
        qty:fill.fillQty, 
        amount:fill.spqty * placedOrder.amount
       }
    })), ...fills.map(fill => prisma.user.update({
      where:{
        id:fill.userId
      },
      data: {
        usdBal: BALANCES[fill.userId]!.USD!.total,
        usdTotal: BALANCES[fill.userId]!.USD!.total, 
        usdLock: BALANCES[fill.userId]!.USD!.locked
      }
    })), ...fills.map(fill => prisma.order.update({
      where: {
        id:fill.orderId
      }, data: {
        status: fill.status,
        filledQty: fill.spqty
      }
    })), ...fills.map(fill: => prisma.userBalance.upsert({
      where:{
        userId_instrumentSymbol:{
          userId:fill.userId, 
          instrumentSymbol:placedOrder.instrumentSymbol
        }
      }, 
      update:{
        total:BALANCES[fill.userId]![order.data.instrumentSymbol]!.total
      }, 
      create:{
        userId:fill.userId, 
        instrumentSymbol:placedOrder.instrumentSymbol, 
        locked: 0, 
        total:BALANCES[fill.userId]![order.data.instrumentSymbol]!.total
      }
    }))])
  //while loop until qty filled or break if amt > purchase bid
    //shift from map orders array... 
      //check qty || greater or lesser
       //transaction
        //subtract qty from seller
        //add qty to buyer 
        //update status for both. (may or not removed from fill array)
        //subtract usd from buyer 
        //add usd to seller 
        //create fill 
  } else {
    
  }

  res.json({
    message: "order added to the order db",
    BALANCES, orderBook, fills
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

app.put("/addusd/:amt", authMiddleWare, async (req, res) => {
  try {
    const amt: number = Number(req.params.amt);
    const result = await prisma.user.update({
      where: {
        username: req.username
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
      message: "balance updated",
      result
    })
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      err
    })
  }
})

await populateBalances();
await populateOrderBook();
app.listen(3000, () => {
  console.dir(orderBook, { depth: null })
  console.log(BALANCES)
})

