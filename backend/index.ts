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
  instrumentSymbol: z.string(),
  amount: z.number(),
  side: z.enum(Side),
  type: z.enum(Type),
  status: z.enum(Status),
  totalQty: z.number().optional(),
  filledQty: z.number().default(0)
})

const depositSchema = z.object({
  instrumentSymbol: z.string(),
  qty: z.number()
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
type OrderInput = z.infer<typeof orderSchema>

type Order = {
  orderId: string,
  userId: string,
  totalqty: number,
  fulfilledqty: number,
  filledqty: number,
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
            totalqty: order.totalQty!,
            fulfilledqty: order.filledQty!,
            filledqty: 0,
            status: order.status
          }])
        } else {
          //since we share the references of the objects and the arrays. we need not set it again 
          symOrderBook?.buy.maxMap.get(order.amount)?.push(
            {
              orderId: order.id,
              userId: order.userId,
              totalqty: order.totalQty!,
              fulfilledqty: order.filledQty!,
              filledqty: 0,
              status: order.status
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
            totalqty: order.totalQty!,
            fulfilledqty: order.filledQty!,
            filledqty: 0,
            status: order.status
          }])
        } else {
          //since we share the references of the objects and the arrays. we need not set it again 
          symOrderBook?.sell.minMap.get(order.amount)?.push(
            {
              orderId: order.id,
              userId: order.userId,
              totalqty: order.totalQty!,
              fulfilledqty: order.filledQty!,
              filledqty: 0,
              status: order.status
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
  if (!deposit.success) {
    return res.status(400).json({
      error: deposit.error.message
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
  if (!Object.hasOwn(BALANCES[user.id]!, deposit.data!.instrumentSymbol)) {
    //make a post request 
    const deposited = await prisma.userBalance.create({
      data: {
        userId: user.id,
        instrumentSymbol: deposit.data!.instrumentSymbol,
        total: deposit.data?.qty
      }
    })
    await populateBalances();
    console.log(BALANCES)
    return res.json({
      message: "deposited",
      deposited
    })
  } else {
    //make a update request because user already has some balance of that specific instrument 
    const deposited = await prisma.userBalance.update({
      where: {
        userId_instrumentSymbol: {
          instrumentSymbol: deposit.data.instrumentSymbol,
          userId: user.id
        }
      },
      data: {
        total: {
          increment: deposit.data.qty
        }
      }
    })
    await populateBalances();
    console.log(BALANCES)
    return res.json({
      message: "deposited",
      deposited
    })
  }
})

app.post("/order", authMiddleWare, async (req, res) => {
  //write -> read from in memory db and run matching engine -> write fills
  const fills: any = []
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
  if(order.data.type == "Limit" && order.data.side == "Buy") {
  if (BALANCES[user.id]!["USD"]!.total < order.data.amount * order.data.totalQty!) {
    return res.status(400).json({
      message: "You don't have sufficient to place bid"
    })
  }
  BALANCES[user.id]!["USD"]!.locked = order.data.amount * order.data.totalQty!;
 } else if(order.data.type == "Limit" && order.data.side == "Sell") {
  if(!(BALANCES[user.id]![order.data.instrumentSymbol]!.total - BALANCES[user.id]![order.data.instrumentSymbol]!.locked < order.data.totalQty!)) {
    return res.status(400).json({
      message: "You don't have sufficient instrument balance to place sell order"
    })
  }
  BALANCES[user.id]![order.data.instrumentSymbol]!.locked = order.data.totalQty!;
 }

//for a sell order we need to check if the user has enough instrument balance. 

  const placedOrder = await prisma.order.create({
    data: {
      ...order.data, userId: user.id
    }
  })

  //matching begins for the buy order. write uska logic here. 
  //since it is a buy limit order. we need to check the sales heap.
  if(order.data.side == "Buy") {
  let ask = orderBook[order.data.instrumentSymbol]?.sell;

  if (Number(ask!.minHeap.peek()) <= order.data.amount) {

    while (order.data.filledQty! < order.data.totalQty!) {
      let sellorders = ask!.minMap.get(ask!.minHeap.peek()!)!
      let sellorder = sellorders.shift()!;
      let filledQty = Math.min(sellorder.totalqty - sellorder.fulfilledqty, order.data.totalQty! - order.data.filledQty!);
      let usdMoved = filledQty * order.data.amount;
      sellorder.fulfilledqty = sellorder.fulfilledqty + filledQty;
      order.data.filledQty = order.data.filledQty! + filledQty;
      BALANCES[user.id]!.USD!.locked = BALANCES[user.id]!.USD!.locked - usdMoved;
      BALANCES[user.id]!.USD!.total = BALANCES[user.id]!.USD!.total - usdMoved;
      if (BALANCES[user.id]![order.data.instrumentSymbol]) {
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
      sellorder.filledqty = filledQty;
      if (sellorder.totalqty - sellorder.fulfilledqty == 0) {
        sellorder.status = "Completed"
        fills.push(sellorder)
        if (sellorders.length == 0) {
          ask!.minMap.delete(ask!.minHeap.peek()!);
          ask!.minHeap.pop()
          if (!(Number(ask!.minHeap.peek()) <= order.data.amount)) break;
        }
      } else {
        sellorder.status = "Partial"
        fills.push(sellorder)
        sellorders.unshift(sellorder)
      }
      if (!ask?.minHeap.peek()) break;
    }
    //time to create a tranasaction.
    if (order.data.filledQty! == order.data.totalQty!) order.data.status = "Completed";
    else {
      if(order.data.type === "Limit") {
      order.data.status = "Partial";
      //add the remaining order to the order book.
      if (orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.has(order.data.amount)) {
        orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.get(order.data.amount)?.push({
          orderId: placedOrder.id,
          userId: user.id,
          totalqty: order.data.totalQty!,
          fulfilledqty: order.data.filledQty!,
          filledqty: 0,
          status: order.data.status
        })
      } else {
        orderBook[placedOrder.instrumentSymbol]?.buy.maxHeap.heapArray.push(order.data.amount);
        orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.set(order.data.amount, [{
          orderId: placedOrder.id,
          userId: user.id,
          totalqty: order.data.totalQty!,
          fulfilledqty: order.data.filledQty!,
          filledqty: 0,
          status: order.data.status
        }])
      }
    } else {
      //market order 
      order.data.status = "Cancelled"
    }}
  } else {
    //add the remaining order to the order book.
    if(order.data.type === "Limit") {
      if (orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.has(order.data.amount)) {
      orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.get(order.data.amount)?.push({
        orderId: placedOrder.id,
        userId: user.id,
        totalqty: order.data.totalQty!,
        fulfilledqty: order.data.filledQty!,
        filledqty: 0,
        status: order.data.status
      })
    } else {
      orderBook[placedOrder.instrumentSymbol]?.buy.maxHeap.heapArray.push(order.data.amount);
      orderBook[placedOrder.instrumentSymbol]?.buy.maxMap.set(order.data.amount, [{
        orderId: placedOrder.id,
        userId: user.id,
        totalqty: order.data.totalQty!,
        fulfilledqty: order.data.filledQty!,
        filledqty: 0,
        status: order.data.status
      }])
    }
    } else {
      order.data.status = "Cancelled"
    }
  }
} else if(order.data.side == "Sell") {
  //i raise an order to sell 5 sol at 150.68
  //bids ka highest price dhundho. is it greater or equal to the selling 
  //maxMap se orders nikalo. find the filled qty 
  //subtract if from my total, add it to the buyers balance. 
  //add usd, remove buyers usd. 
  //if it is not, then add it to the order book
  let bid = orderBook[order.data.instrumentSymbol]?.buy;
  if (Number(bid!.maxHeap.peek()) >= order.data.amount) {
    while(order.data.filledQty! < order.data.totalQty!) {
      let buyorders = bid!.maxMap.get(bid!.maxHeap.peek()!)!
      let buyorder = buyorders.shift()!;
      let filledQty = Math.min(buyorder.totalqty - buyorder.fulfilledqty, order.data.totalQty! - order.data.filledQty!);
      let usdMoved = filledQty * order.data.amount;
      buyorder.fulfilledqty = buyorder.fulfilledqty + filledQty;
      order.data.filledQty = order.data.filledQty! + filledQty;
      BALANCES[user.id]!.USD!.total = BALANCES[user.id]!.USD!.total + usdMoved;
      BALANCES[user.id]![order.data.instrumentSymbol]!.locked -= filledQty;
      BALANCES[user.id]![order.data.instrumentSymbol]!.total -= filledQty;
      if(BALANCES[buyorder.userId]![order.data.instrumentSymbol]) {
        BALANCES[buyorder.userId]![order.data.instrumentSymbol]!.total += filledQty;
      } else {
        BALANCES[buyorder.userId]![order.data.instrumentSymbol] = {
          total:filledQty, 
          locked:0
        }
      }
      BALANCES[buyorder.userId]!.USD!.total -= usdMoved; 
      BALANCES[buyorder.userId]!.USD!.locked -= usdMoved; 
      buyorder.filledqty = filledQty; 
      if (buyorder.totalqty - buyorder.fulfilledqty == 0) {
        buyorder.status = "Completed"
        fills.push(buyorder)
        if (buyorders.length == 0) {
          bid!.maxMap.delete(bid!.maxHeap.peek()!);
          bid!.maxHeap.pop()
          if (!(Number(bid!.maxHeap.peek()) <= order.data.amount)) break;
        }
      } else {
        buyorder.status = "Partial"
        fills.push(buyorder)
        buyorders.unshift(buyorder)
      }
      if (!bid?.maxHeap.peek()) break;
    }
    if (order.data.filledQty! == order.data.totalQty!) order.data.status = "Completed";
    else {
      if(order.data.type === "Limit") {
        order.data.status = "Partial";
      //add the remaining order to the order book.
      if (orderBook[placedOrder.instrumentSymbol]?.sell.minMap.has(order.data.amount)) {
        orderBook[placedOrder.instrumentSymbol]?.sell.minMap.get(order.data.amount)?.push({
          orderId: placedOrder.id,
          userId: user.id,
          totalqty: order.data.totalQty!,
          fulfilledqty: order.data.filledQty!,
          filledqty: 0,
          status: order.data.status
        })
      } else {
        orderBook[placedOrder.instrumentSymbol]?.sell.minHeap.heapArray.push(order.data.amount);
        orderBook[placedOrder.instrumentSymbol]?.sell.minMap.set(order.data.amount, [{
          orderId: placedOrder.id,
          userId: user.id,
          totalqty: order.data.totalQty!,
          fulfilledqty: order.data.filledQty!,
          filledqty: 0,
          status: order.data.status
         }])
      }
      } else {
        order.data.status = "Cancelled"
      }
    }
    console.log(fills)
  } else {
    if(order.data.type === "Limit") {
        if (orderBook[placedOrder.instrumentSymbol]?.sell.minMap.has(order.data.amount)) {
      orderBook[placedOrder.instrumentSymbol]?.sell.minMap.get(order.data.amount)?.push({
        orderId: placedOrder.id,
        userId: user.id,
        totalqty: order.data.totalQty!,
        fulfilledqty: order.data.filledQty!,
        filledqty: 0,
        status: order.data.status
      })
    } else {
      orderBook[placedOrder.instrumentSymbol]?.sell.minHeap.heapArray.push(order.data.amount);
      orderBook[placedOrder.instrumentSymbol]?.sell.minMap.set(order.data.amount, [{
        orderId: placedOrder.id,
        userId: user.id,
        totalqty: order.data.totalQty!,
        fulfilledqty: order.data.filledQty!,
        filledqty: 0,
        status: order.data.status
      }])
    }
    } else {
      order.data.status = "Cancelled";
    }
  }
}
  if(order.data.type === "Limit") {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: {
          id: user.id,
        },
        data: {
          usdBal: BALANCES[user.id]!.USD!.total,
          usdTotal: BALANCES[user.id]!.USD!.total,
          usdLock: BALANCES[user.id]!.USD!.locked,
        },
      });

      await tx.order.update({
        where: {
          id: placedOrder.id,
        },
        data: {
          status: order.data.status,
          filledQty: order.data.filledQty,
        },
      });

      await tx.userBalance.upsert({
        where: {
          userId_instrumentSymbol: {
            userId: user.id,
            instrumentSymbol: placedOrder.instrumentSymbol,
          },
        },
        update: {
          total: BALANCES[user.id]![order.data.instrumentSymbol]!.total,
        },
        create: {
          userId: placedOrder.userId,
          instrumentSymbol: placedOrder.instrumentSymbol,
          locked: 0,
          total: BALANCES[user.id]![order.data.instrumentSymbol]!.total,
        },
      });

      for (const fill of fills) {
        await tx.fill.create({
          data: {
            buyOrderId: placedOrder.id,
            sellOrderId: fill.orderId,
            instrumentId: placedOrder.instrumentId,
            qty: fill.filledqty,
            amount: fill.fulfilledqty * placedOrder.amount,
          },
        });
      }

      for (const fill of fills) {
        await tx.user.update({
          where: {
            id: fill.userId,
          },
          data: {
            usdBal: BALANCES[fill.userId]!.USD!.total,
            usdTotal: BALANCES[fill.userId]!.USD!.total,
            usdLock: BALANCES[fill.userId]!.USD!.locked,
          },
        });
      }

      for (const fill of fills) {
        await tx.order.update({
          where: {
            id: fill.orderId,
          },
          data: {
            status: fill.status,
            filledQty: fill.fulfilledqty,
          },
        });
      }

      for (const fill of fills) {
        await tx.userBalance.upsert({
          where: {
            userId_instrumentSymbol: {
              userId: fill.userId,
              instrumentSymbol: placedOrder.instrumentSymbol,
            },
          },
          update: {
            total: BALANCES[fill.userId]![order.data.instrumentSymbol]!.total,
            locked: BALANCES[fill.userId]![order.data.instrumentSymbol]!.locked
          },
          create: {
            userId: fill.userId,
            instrumentSymbol: placedOrder.instrumentSymbol,
            locked: 0,
            total: BALANCES[fill.userId]![order.data.instrumentSymbol]!.total,
          },
        });
      }
      // fills.length = 0;
    });
  }

  res.json({
    message: "order added to the order db",
    BALANCES, orderBook, fills
  })
})

app.delete("/order/:orderId", authMiddleWare, async (req, res) => {
  const orderId = req.params.orderid; 
  if(!orderId || Array.isArray(orderId)) {
    return res.status(400).json({
      message:"Invalid orderId"
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
  const result = await prisma.order.findUnique({
    where: {
      id:orderId, 
    }
  })
  if(result?.userId != user.id) {
    return res.status(400).json({
      message:"Cannot delete someone else's order"
    })
  }
  const deleted = await prisma.order.delete({
    where: {
      id:orderId, 
    }
  })
  res.send(deleted)
})

app.get("/orders", async (req, res) => {
  const orders = await prisma.order.findMany()
  res.send(orders)
})

app.get("/orderbook/:symbol", (req, res) => {
  //{sell: [{price:300, qty:5}, {price:250, qty:10}], buy: [{price:200, qty:10}, {price:150, qty:20}]}
  const symbol = req.params.symbol;
  if(!symbol || Array.isArray(symbol)) {
    return res.status(400).json({
      message: "Invalid symbol"
    })
  } 
  let sell = [];
  let buy = [];
  if(!orderBook[symbol]) {
    return res.status(400).send("no data exists")
  }
  for(const key of orderBook[symbol]?.buy.maxMap.keys()) {
    let e = orderBook[symbol].buy.maxMap.get(key);
    if(e && e?.length == 0) {
      return; 
    }
    for(let i = 0; i < e!.length; i++) {
      let obj = {
      price:key, totalQty:e![i]!.totalqty
    }
    buy.push(obj)
    }
  }
  for(const key of orderBook[symbol]?.sell.minMap.keys()) {
    let e = orderBook[symbol].sell.minMap.get(key);
    if(e && e?.length == 0) {
      return; 
    }
    for(let i = 0; i < e!.length; i++) {
      let obj = {
      price:key, totalQty:e![i]!.totalqty
    }
    sell.push(obj)
    }
  }
  res.json({
    buy, sell
  })
})

app.get("/fills/:symbol", async (req, res) => {
  const symbol = req.params.symbol;
  if(!symbol || Array.isArray(symbol)) {
    return res.status(400).send("symbol dne")
  }
  const symbolid = await prisma.instrument.findUnique({
    where: {
      symbol
    }
  })
  if(!symbolid) {
    return res.status(400).send("invavlid symbol")
  }
  const result = await prisma.fill.findMany({
    where:{
      instrumentId:symbolid?.id
    }
  })
  res.send(result)
})


app.get("balance", authMiddleWare, async (req, res) => {
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
  const bal = BALANCES[user.id]; 
  res.json(bal)
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

