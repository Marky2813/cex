import { createClient } from "redis";
import { Heap } from 'heap-js';
import { string, symbol, z } from "zod/v4";
import { parse } from "dotenv";
import { ParseStatus } from "zod/v3";
import { prisma } from "../backend/db"
import { Side, Type, Status } from "../backend/generated/prisma/enums"
import { responseClient, client } from "../redis"

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


const balances: Balances = {};
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
type OrderInput = {
  instrumentId: string,
  instrumentSymbol: string,
  userId:string,
  amount: number,
  side: string,
  type: string,
  status: string,
  totalQty?: number,
  filledQty: number, 
  identifier: number, 
  queueId:string
}

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
    "buy": {
      maxHeap: new Heap(Heap.maxComparator),
      maxMap: new Map<number, Order[]>()
    },
    "sell": {
      minHeap: new Heap(Heap.minComparator),
      minMap: new Map<number, Order[]>()
    }
  }
}

async function loadOrderBook() {
  const orders = await prisma.order.findMany({
    where: {
      status: {
        in: ["Pending", "Partial"]
      }
    }
  })
  orders.map((order) => {
    if (order.type === "Limit") {
      if (order.side === "Buy") {
        if (!orderBook[order.instrumentSymbol]) {
          orderBookInit(order.instrumentSymbol)
        }
        const currentorder = {
          orderId: order.id,
          userId: order.userId,
          totalqty: order.totalQty,
          fulfilledqty: 0,
          filledqty: order.filledQty,
          status: order.status
        }
        // how to add to maxHeap and how to append to the value of the key. 
        if (!orderBook[order.instrumentSymbol]?.buy.maxMap.has(order.amount)) {
          orderBook[order.instrumentSymbol]?.buy.maxMap.set(order.amount, [currentorder])
          orderBook[order.instrumentSymbol]?.buy.maxHeap.heapArray.push(order.amount)
        } else {
          orderBook[order.instrumentSymbol]?.buy.maxMap.get(order.amount)?.push(currentorder)
          orderBook[order.instrumentSymbol]?.buy.maxHeap.heapArray.push(order.amount)
        }
      } else if (order.side === "Sell") {
        if (!orderBook[order.instrumentSymbol]) {
          orderBookInit(order.instrumentSymbol)
        }
        const currentorder = {
          orderId: order.id,
          userId: order.userId,
          totalqty: order.totalQty,
          fulfilledqty: 0,
          filledqty: order.filledQty,
          status: order.status
        }
        // how to add to maxHeap and how to append to the value of the key. 
        if (!orderBook[order.instrumentSymbol]?.sell.minMap.has(order.amount)) {
          orderBook[order.instrumentSymbol]?.sell.minMap.set(order.amount, [currentorder])
          orderBook[order.instrumentSymbol]?.sell.minHeap.heapArray.push(order.amount)
        } else {
          orderBook[order.instrumentSymbol]?.sell.minMap.get(order.amount)?.push(currentorder)
          orderBook[order.instrumentSymbol]?.sell.minHeap.heapArray.push(order.amount)
        }
      }
    }
  })
  console.dir(orderBook, { depth: null })
}
await loadOrderBook()


async function loadBalances() {
  const users = await prisma.user.findMany({
    include: {
      balance: true
    }
  })
  for (const user of users) {
    balances[user.id] = {
      "USD": {
        total: user.usdTotal,
        locked: user.usdLock
      }
    }
    for (const instrument of user.balance) {
      balances[user.id]![instrument.instrumentSymbol] = {
        total: instrument.total,
        locked: instrument.locked
      }
    }
  }
  console.log(balances)
}

await loadBalances()



while (1) {
  const response = await client.brPop("incoming-order", 1);
  if (!response) continue;
  // console.log(response)
  const order:OrderInput = JSON.parse(response.element);
  console.log(order)

  if (order.type == "Limit") {
    //check if user has sufficient balance to place order. 
    if (order.side === "Buy") {
      // before placing the order we need to first check if even the order can be placed. 
      const hasEnoughBalance = balances[order.userId]!["USD"]?.total!-balances[order.userId]!["USD"]?.locked! >= order.amount*order.totalQty!;
      if(!(hasEnoughBalance)) {
        await responseClient.lPush("order-response" + order.queueId, JSON.stringify({ error:"insufficient_funds", message:"cannot place order because the user does not have enough balance.", identifier: order.identifier }));
        continue; 
      }

      //lock the money for the order
      balances[order.userId]!["USD"]!.locked! += order.amount*order.totalQty!;

      //order matching logic..
      //the possibility that this instrument does not exist in the orderbook and this is the first buy order
      if(!orderBook[order.instrumentId]) {
        orderBookInit(order.instrumentId)
      }
      const askAmount = orderBook[order.instrumentId]!.sell.minHeap.heapArray.pop();
      if(!askAmount || askAmount <= order.amount) {
        // create order on prisma and then add it to orderbook.
        // orderBook[order.instrumentId]!.buy.maxHeap.heapArray.push(order.amount); 
        // const hasOrderAtSamePrice = orderBook[order.instrumentId]!.buy.maxMap.get(order.amount)
        // if(hasOrderAtSamePrice) orderBook[order.instrumentId]!.buy.maxMap.get(order.amount)!.push(order)
        // orderBook[order.instrumentId]!.buy.maxMap.set(order.amount, )
      } else {
        // ask order less than or equal to the buy order exist, matching possible. 
        const fills = []; 
        while(order.filledQty < order.totalQty!){
          const askOrder = orderBook[order.instrumentId]!.sell.minMap.get(askAmount!)?.shift();
          //askOrder cannot be undefined because we have already checked that askAmount exists in the minMap.

          //calculate the exchange quantity 
          const exchangedQuantity = Math.min(order.totalQty!-order.filledQty, askOrder!.totalqty-askOrder!.filledqty);

          //exchange instrument
          balances[askOrder?.userId!]![order.instrumentSymbol]!.locked -= exchangedQuantity; 
          balances[askOrder?.userId!]![order.instrumentSymbol]!.total -= exchangedQuantity; 
          balances[order.userId]![order.instrumentSymbol]!.total += exchangedQuantity; 

          //exchange money
          balances[order.userId]!["USD"]!.locked -= order.amount*exchangedQuantity; 
          balances[order.userId]!["USD"]!.total -= order.amount*exchangedQuantity; 
          balances[askOrder!.userId]!["USD"]!.total += order.amount*exchangedQuantity; 

          //change the fill and fulfilled qty 
          askOrder!.fulfilledqty +=exchangedQuantity; 
          order.filledQty += exchangedQuantity; 
          
          const fill = {
            instrumentId: order.instrumentId,
            filledQuantity: exchangedQuantity,
            amount: order.amount * exchangedQuantity
          }

          fills.push(fill);


          //check if order is completed, if it is then break. else check if the current ask order got completed or if the sell side is out of orders and buy order is not completed then break. 
        }
      }

    }
    const filledQuantity = order.amount;
    await responseClient.lPush("order-response" + order.queueId, JSON.stringify({ filledQuantity, identifier: order.identifier }))
    console.log("published")
  }
  if (order.type == "Market") {

  }
  if (order.type == "usdbal") {
    //update the users usd balance. 
    const result = await prisma.user.update({
      where: {
        username: order.username
      },
      data: {
        usdBal: {
          increment: order.amt
        },
        usdTotal: {
          increment:order.amt
        }
      }
    }
    )
    if(balances[result.id]!["USD"]) {
      balances[result.id]!["USD"]!.total = balances[result.id]!["USD"]?.total + order.amt;  
    } else {
      balances[result.id]!["USD"] = {
        locked:0, 
        total:order.amt 
      }
    }
    console.log("updated", result, balances);
  }
}