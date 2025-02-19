// @ts-check
// @ts-ignore
import { join, parse } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import GDPRWebhookHandlers from "./gdpr.js";
// @ts-ignore
import axios from "axios";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import { query, querySingle } from './db.js';


//var con = mysql.createConnection({
 // host: "localhost",
 // user: "root",
 // password: "",
 // database:'upsell'
//});
const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);


const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/web/frontend/dist`
    : `${process.cwd()}/web/frontend/`;


const app = express();

// cors setup
app.use(cors({
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
}));


// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: GDPRWebhookHandlers })
);


// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js
app.use(express.json());


// Start Frontend

async function getOffers() {
  const response = await fetch('/api/graphql');
  const data = await response.json();
   console.log("offer data", data);
  return data;
}


app.post("/api/offer", async (req, res) => {
  const token = req.body.token;
  try {
    jwt.verify(token, 'dfd6dd7718320d69e5909d47c81e6d68');
  } catch (e) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    const productsResponse = await getOffers();
    const products = productsResponse.data.products.edges;

    res.json({ products });
  } catch (error) {
    res.status(500).send("Internal Server Error");
  }
});

// Get Order
async function getAllOrders(id, shop, token) {
  const ordersPerPage = 10;
  let hasNextPage = true;
  let cursor = null;

  const allOrders = [];

  while (hasNextPage) {
    try {
      let data = JSON.stringify({
        "query": "query($customerId: ID!, $ordersPerPage: Int!, $cursor: String) { customer(id: $customerId) { id displayName orders(first: $ordersPerPage, after: $cursor) { pageInfo { hasNextPage endCursor } edges { node { id name tags createdAt totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 5) { edges { node { id title quantity variant { title price } } } } } } } } }",
        "variables": {
          "customerId": `gid://shopify/Customer/${id}`,
          "ordersPerPage": ordersPerPage,
          "cursor": cursor
        }
      });

      let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: `https://${shop}/admin/api/unstable/graphql.json`,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          'Cookie': 'request_method=POST'
        },
        data: data
      };

      const response = await axios.request(config);
      console.log('GraphQL Response:', response.data);

      const orderEdges = response?.data?.data?.customer?.orders?.edges;

      if (orderEdges) {
        allOrders.push(...orderEdges.map(orderEdge => orderEdge?.node));
      } else {
        console.error('No order edges found in the response.');
      }

      cursor = response?.data?.data?.customer?.orders?.pageInfo?.endCursor;
      hasNextPage = response?.data?.data?.customer?.orders?.pageInfo?.hasNextPage;
    } catch (error) {
      console.error('Error processing orders:', error);
      return;
    }
  }

  // Sort orders by creation date in descending order
  // @ts-ignore
  const sortedOrders = allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  console.log('sortedOrders', sortedOrders);

  return sortedOrders;
}

// Get Customer Email
async function getQueryResponse(query, shop, token) {
  try {
    let data = JSON.stringify({
      query: query,
      variables: {}
    });

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: `https://${shop}/admin/api/unstable/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      data: data
    };

    const response = await axios.request(config);
    var customer_data = response?.data;
    console.log("customer_data", customer_data);
    return customer_data;
  } catch (error) {
    console.log(error);
    return null;
  }
}

// Function to make a GraphQL request to update order tags
async function updateOrderTags(id, shop, tags, token) {
  console.log('update tags', tags);
  console.log('update id', id);
  try {
    // Construct the GraphQL mutation
    const mutation = `
      mutation UpdateOrderTags($orderId: ID!, $tags: [String!]!) {
        orderUpdate(input: { id: $orderId, tags: $tags }) {
          order {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Define the variables for the mutation
    const variables = {
      orderId: id,
      tags: tags,
    };

    // Make the GraphQL request to update the order tags
    const response = await axios.post(`https://${shop}/admin/api/unstable/graphql.json`, {
      query: mutation,
      variables: variables,
    }, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    });

    // Handle the response
    if (response.status === 200) {
      console.log('Order tags updated successfully.');
      console.log("update order tag", JSON.stringify(response.data));

      // Return the updated order details
      return response?.data?.data?.orderUpdate?.order;
    } else {
      console.error('Failed to update order tags. Status:', response.status);
    }
  } catch (error) {
    console.error('Error updating order tags:', error);
  }
}


// Initialize an object to track processed interactions
const tagsToAdd = ['Wisedge']; // Specify the tags to add

// @ts-ignore
app.post("/api/sign-changeset", cors(), async (req, res) => {
  try {
    // Verify the JWT token
    jwt.verify(req.body.token, 'dfd6dd7718320d69e5909d47c81e6d68');

    const {
      changes: proVariant,
      customerId,
      shop,
      isOrderFromPostPurchaseApp,
      // @ts-ignore
      referenceId
    } = req.body;

    // Get shop details using parameterized query
    const shopQuery = {
      text: 'SELECT access_token FROM shop WHERE shop = $1',
      values: [shop]
    };

    const shopResult = await query(shopQuery.text, shopQuery.values);
    
    if (!shopResult.rows.length) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    // @ts-ignore
    const tokenFinal = shopResult.rows[0].access_token;
    let customerDetail = [];
    let orderDetail = null;

    if (isOrderFromPostPurchaseApp) {
      try {
        // Get customer email
        const customerEmailQuery = `query {
          customer(id: "gid://shopify/Customer/${customerId}") {
            email
          }
        }`;
        
        const customerEmailResponse = await getQueryResponse(customerEmailQuery, shop, tokenFinal);
        const customerEmail = customerEmailResponse?.data?.customer?.email;
        
        if (!customerEmail) {
          throw new Error('Customer email not found');
        }

        // Get last order
        const orderQuery = `query {
          orders(first: 1, query: "email:${customerEmail}", reverse: true) {
            edges {
              node {
                id
                displayFinancialStatus
              }
            }
          }
        }`;

        const lastOrderResponse = await getQueryResponse(orderQuery, shop, tokenFinal);
        const lastOrderId = lastOrderResponse?.data?.orders?.edges?.[0]?.node?.id;

        if (!lastOrderId) {
          throw new Error('Last order not found');
        }

        // Get all customer orders
        const customerOrders = await getAllOrders(customerId, shop, tokenFinal);
        
        // @ts-ignore
        if (customerOrders?.length > 0) {
          // @ts-ignore
          const latestOrder = customerOrders[0];
          
          if (latestOrder) {
            // Update order tags
            try {
              orderDetail = await updateOrderTags(lastOrderId, shop, tagsToAdd, tokenFinal);
            } catch (updateError) {
              console.error('Error updating order tags:', updateError);
              throw new Error('Failed to update order tags');
            }
          }
        }

        if (!orderDetail) {
          return res.status(404).json({ error: 'No matching order found' });
        }
      } catch (error) {
        console.error('Error processing post-purchase order:', error);
        return res.status(500).json({ error: 'Error processing order' });
      }
    }

    const payload = {
      iss: 'f34c81756ca9b5bf87c04118fff20ed2',
      jti: uuidv4(),
      iat: Math.floor(Date.now() / 1000),
      sub: req.body.referenceId, // Use the current order's ID as the identifier
      changes: [
        {
          type: "add_variant",
          variantID: proVariant,
          quantity: 1,
          discount: {
            value: 10,
            valueType: "percentage",
            title: "10% off",
          },
        },
      ],
    };
    const token = jwt.sign(payload, 'dfd6dd7718320d69e5909d47c81e6d68');



    return res.status(200).json({
      token,
      customer_detail: customerDetail,
      order_detail: orderDetail,
    });

  } catch (error) {
    console.error('Error in sign-changeset:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
});



// Accept Product Data
function getAcceptProductData(id,shop,token){
  let data = JSON.stringify({
    query: `{
  product(id: "gid://shopify/Product/`+id+`") {
        title
        id
        legacyResourceId
        variants(first: 10) {
            edges {
                node {
                    id
                    price
                    compareAtPrice
                    legacyResourceId
                }
            }
        }
        description
        images(first: 5) {
            edges {
                node {
                altText
                originalSrc
                }
            }
            }
  }
  }`,
    variables: {}
  });
  
  let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: `https://${shop}/admin/api/unstable/graphql.json`,
    headers: { 
      'X-Shopify-Access-Token': token, 
      'Content-Type': 'application/json', 
      'Cookie': 'request_method=POST'
    },
    data : data
  };
  
  //let product_data = '';

  return axios.request(config)
  .then((response) => {
    return JSON.stringify(response.data);
  })
  .catch((error) => {
    console.log(error);
  });
  
}


function  getDeclineProductData(id, shop, token){
  let data = JSON.stringify({
    query: `{
  product(id: "gid://shopify/Product/`+id+`") {
        title
        id
        legacyResourceId
        variants(first: 10) {
            edges {
                node {
                    id
                    price
                    compareAtPrice
                    legacyResourceId
                }
            }
        }
        description
        images(first: 5) {
            edges {
                node {
                altText
                originalSrc
                }
            }
            }
  }
  }`,
    variables: {}
  });
  
  let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: `https://${shop}/admin/api/unstable/graphql.json`,
    headers: { 
      'X-Shopify-Access-Token': token, 
      'Content-Type': 'application/json', 
      'Cookie': 'request_method=POST'
    },
    data : data
  };
  
  //let product_data = '';

  return axios.request(config)
  .then((response) => {
    return JSON.stringify(response?.data);
  })
  .catch((error) => {
    console.log(error);
  });
  
}

const handleDatabaseError = (err, res) => {
  console.error('Database error:', err);
  return res.status(500).json({
    status: false,
    error: 'Internal server error'
  });
};

app.post("/api/get-offer", cors(), async (req, res) => {
  try {
    const { productarray: products, shop } = req.body;
    
    if (!Array.isArray(products) || !shop) {
      return res.status(400).json({
        status: false,
        error: 'Invalid input parameters'
      });
    }

    // Get shop details
    const shopQuery = {
      text: 'SELECT access_token, status FROM shop WHERE shop = $1',
      values: [shop]
    };
    
    const shopResult = await query(shopQuery.text, shopQuery.values);
    
    if (shopResult.rows.length === 0) {
      return res.json({ status: false });
    }

    // @ts-ignore
    const { access_token: tokenFinal, status } = shopResult.rows[0];

    if (status !== 'true') {
      return res.json({ status: false });
    }

    // Get funnel data
    const getFunnelQuery = {
      text: `
        SELECT * FROM funnel 
        WHERE main_product_id = ANY($1)
        AND funnel_status = 'published' 
        AND shop = $2 
        LIMIT 1
      `,
      values: [products, shop]
    };

    const funnelResult = await query(getFunnelQuery.text, getFunnelQuery.values);

    if (funnelResult.rows.length === 0) {
      return res.json({ status: false });
    }

    // @ts-ignore
    const acceptProductId = funnelResult.rows[0].accept_product_id;

    // Get product details
    const productResult = await getAcceptProductData(acceptProductId, shop, tokenFinal);
    return res.json(productResult);

  } catch (err) {
    return handleDatabaseError(err, res);
  }
});

app.post("/api/decline-offer", cors(), async (req, res) => {
  try {
    const { productarray: products, shop } = req.body;

    if (!Array.isArray(products) || !shop) {
      return res.status(400).json({
        status: false,
        error: 'Invalid input parameters'
      });
    }

    // Get shop details
    const shopQuery = 'SELECT access_token FROM shop WHERE shop = $1';
    const shopResult = await querySingle(shopQuery, [shop]);

    if (!shopResult) {
      return res.json({ status: false });
    }

    // @ts-ignore
    const tokenFinal = shopResult.access_token;

    // Get funnel data
    const getFunnelQuery = 'SELECT decline_product_id FROM funnel WHERE main_product_id = ANY($1)';
    const funnelResult = await querySingle(getFunnelQuery, [products]);

    if (!funnelResult) {
      return res.json({ status: false });
    }

    // @ts-ignore
    const declineProductId = funnelResult.decline_product_id;

    // Get decline product details
    const declineResult = await getDeclineProductData(declineProductId, shop, tokenFinal);
    return res.json(declineResult);

  } catch (err) {
    return handleDatabaseError(err, res);
  }
});


// Decline changeset route with safe queries
// @ts-ignore
app.post("/api/decline-changeset", cors(), async (req, res) => {
  try {
    jwt.verify(req.body.token, 'dfd6dd7718320d69e5909d47c81e6d68');

    const { customerId, changes: proVariant, shop, isOrderFromPostPurchaseApp, referenceId } = req.body;

    const shopResult = await query(
      'SELECT * FROM shop WHERE shop = $1',
      [shop]
    );

    if (!shopResult.rows.length) {
      return res.status(404).send("Shop not found");
    }

    // @ts-ignore
    const tokenFinal = shopResult.rows[0].access_token;
    let customer_detail = [];
    let order_detail = [];

    if (isOrderFromPostPurchaseApp) {
      const customerEmailResponse = await getQueryResponse(
        `query { customer(id: "gid://shopify/Customer/${customerId}") { email } }`,
        shop,
        tokenFinal
      );
      
      const customerEmail = customerEmailResponse?.data?.customer?.email;
      
      const lastOrderResponse = await getQueryResponse(
        `query { orders(first: 1, query: "email:${customerEmail}",reverse:true) { edges { node { id displayFinancialStatus } } } }`,
        shop,
        tokenFinal
      );
      
      const lastOrderId = lastOrderResponse?.data?.orders?.edges?.[0]?.node?.id;
      const customer_detail_data = await getAllOrders(customerId, shop, tokenFinal);
      customer_detail.push(customer_detail_data);

      if (customer_detail.length > 0) {
        try {
          order_detail = await updateOrderTags(lastOrderId, shop, tagsToAdd, tokenFinal);
        } catch (updateError) {
          console.error(updateError);
          return res.status(500).send("Error updating order tags");
        }
      }
    }

    const payload = {
      iss: 'f34c81756ca9b5bf87c04118fff20ed2',
      jti: uuidv4(),
      iat: Math.floor(Date.now() / 1000),
      sub: referenceId,
      changes: [{
        type: "add_variant",
        variantID: proVariant,
        quantity: 1,
        discount: {
          value: 10,
          valueType: "percentage",
          title: "10% off",
        },
      }],
    };

    const token = jwt.sign(payload, 'dfd6dd7718320d69e5909d47c81e6d68');
    res.status(200).json({ token, customer_detail, order_detail });
  } catch (e) {
    console.error(e);
    res.status(401).send("Unauthorized");
  }
});
// Get Shop Token route with safe queries
app.use("/api/*", shopify.validateAuthenticatedSession());

// @ts-ignore
app.get("/api/shopToken", async (req, res) => {
  try {
    const session_data = res.locals.shopify?.session;

    if (!session_data) {
      return res.status(401).json({ error: "Unauthorized: No session found" });
    }

    console.log("session_data:", session_data);

    const shop = session_data.shop;
    const token = session_data.accessToken;
    const date = new Date().toJSON().slice(0, 10);

    const result = await query("SELECT * FROM shop WHERE shop = $1", [shop]);

    if (result.rows.length > 0) {
      // @ts-ignore
      if (result.rows[0].access_token !== token) {
        await query(
          "UPDATE shop SET access_token = $1, date = $2 WHERE shop = $3",
          [token, date, shop]
        );
      }
    } else {
      await query(
        "INSERT INTO shop (shop, access_token, status, date) VALUES ($1, $2, $3, $4)",
        [shop, token, "true", date]
      );
    }

    res.json(result.rows);
  } catch (err) {
    console.error("Error in shopToken:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});


/// Update App Status route with safe queries
app.put('/api/shopStatus', async (req, res) => {
  try {
    const { id: shopId, status: newStatus } = req.body;

    const result = await query(
      'UPDATE shop SET status = $1 WHERE id = $2 RETURNING *',
      [newStatus, shopId]
    );

    res.send({
      userId: shopId,
      data: result.rows
    });
  } catch (err) {
    console.error('Error updating shop status:', err);
    res.status(500).send('Internal Server Error');
  }
});


// Function to fetch sales data
async function getSales(shop, token, cursor, finalDate, tagQuery) {
  let query = '';
  if(cursor == '') {
    query = `
    {
      shop {
        orders(first: 10, query: "created_at:>${finalDate}T00:00:00Z ${tagQuery}", sortKey: CREATED_AT) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              totalPriceSet {
                shopMoney {
                  amount
                }
              }
              tags
            }
          }
        }
      }
    }
  `;
  } else {
  query = `
    {
      shop {
        orders(first: 10, after: "${cursor}", query: "created_at:>${finalDate}T00:00:00Z ${tagQuery}", sortKey: CREATED_AT) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              totalPriceSet {
                shopMoney {
                  amount
                }
              }
              tags
            }
          }
        }
      }
    }
  `;
  }
  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: `https://${shop}/admin/api/unstable/graphql.json`,
    headers: { 
      'X-Shopify-Access-Token': token, 
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({ query }),
  };

  try {
    const response = await axios.request(config);
    return response.data;
  } catch (error) {
    console.error('Error fetching sales data:', error);
    throw error;
  }
}

// Function to calculate the average of an array
function calculateAverage(arr) {
  if (arr.length === 0) {
    return 0;
  }
  
  const sum = arr.reduce((total, value) => total + value, 0);
  return sum / arr.length;
}

// @ts-ignore
app.post('/api/order', async (req, res) => {
  try {
    const session_data = res.locals.shopify.session;
  
    const shop = session_data.shop;
    const token = session_data.accessToken;

    const dateResult = await query(
      'SELECT date FROM shop WHERE shop = $1',
      [shop]
    );

    if (!dateResult.rows.length) {
      return res.status(404).send('Shop not found');
    }

    // @ts-ignore
    const saleDate = new Date(dateResult.rows[0].date).toJSON().slice(0, 10);
    const todayDate = new Date().toJSON().slice(0, 10);

    // Fetch sales data for all tags (including blank tags)
    let cursor = '';
    var totalSalesAllTags = 0;
    let allTagOrders = []; // Store all orders with tags for later use

    while (true) { // Infinite loop to gather all orders
      const orderRes = await getSales(shop, token, cursor, saleDate, '');

      if (!orderRes || !orderRes.data || !orderRes.data.shop || !orderRes.data.shop.orders || !orderRes.data.shop.orders.edges) {
        // Break if there's no more data or an unexpected response
        break;
      }

      const orderData = orderRes.data.shop.orders;
      const edges = orderData.edges;

      if (edges.length === 0) {
        // No more orders, break the loop
        break;
      }

      cursor = orderData.pageInfo.endCursor;

      for (const order of edges) {
        const newAmount = parseFloat(order.node.totalPriceSet.shopMoney.amount);
        totalSalesAllTags += newAmount;
        allTagOrders.push(order); // Store all orders for later use
      }
    }

    // @ts-ignore
    totalSalesAllTags = totalSalesAllTags.toFixed(2);

    // Calculate the average sale for all tags
    const averageSaleAllTags = calculateAverage(allTagOrders.map(order => parseFloat(order.node.totalPriceSet.shopMoney.amount))).toFixed(2);

    // Fetch sales data using Wisedge tags
    cursor = '';
    let totalSalesWisedge = 0;

    while (true) { // Infinite loop to gather all Wisedge orders
      const orderRes = await getSales(shop, token, cursor, saleDate, 'tag:Wisedge');

      if (!orderRes || !orderRes.data || !orderRes.data.shop || !orderRes.data.shop.orders || !orderRes.data.shop.orders.edges) {
        // Break if there's no more data or an unexpected response
        break;
      }

      const orderData = orderRes.data.shop.orders;
      const edges = orderData.edges;

      if (edges.length === 0) {
        // No more Wisedge orders, break the loop
        break;
      }

      cursor = orderData.pageInfo.endCursor;

      for (const order of edges) {
        const newAmount = parseFloat(order.node.totalPriceSet.shopMoney.amount);
        totalSalesWisedge += newAmount;
      }
    }

    // @ts-ignore
    totalSalesWisedge = totalSalesWisedge.toFixed(2);

    // Fetch today's sales and calculate average using Wisedge tags
    const todayOrderRes = await getSales(shop, token, '', todayDate, 'tag:Wisedge');
    const todayOrderData = todayOrderRes.data.shop.orders.edges;
    let todaySales = 0;
    const avgOrder = [];

    for (const order of todayOrderData) {
      const newAmount = parseFloat(order.node.totalPriceSet.shopMoney.amount);
      todaySales += newAmount;
      avgOrder.push(newAmount);
    }

    // @ts-ignore
    todaySales = todaySales.toFixed(2);
    // @ts-ignore
    const avg = calculateAverage(avgOrder);

    // Calculate the average order value
    const numberOfOrdersToday = todayOrderData.length;
    const avgOrderValue = numberOfOrdersToday > 0 ? todaySales / numberOfOrdersToday : 0;
    const upsellAverage = avgOrderValue.toFixed(2);
    res.send({
      total_sales_all_tags: totalSalesAllTags,
      average_sale_all_tags: averageSaleAllTags,
      total_sales_wisedge: totalSalesWisedge,
      today_sales: todaySales,
      upsell_avrg: upsellAverage,
    });
  } catch (err) {
    console.error('Error in order endpoint:', err);
    res.status(500).send('Internal Server Error');
  }
});



// Get Graphql
// @ts-ignore
app.get('/api/graphql', (req, res) => {
  var session_data = res.locals.shopify.session;

  // console.log('session_data', session_data);
  var shop = session_data['shop'];
  var token = session_data['accessToken'];
  let data = JSON.stringify({
  query: `{
  products(first: 50) {
    edges {
      node {
        title
        legacyResourceId
        variants(first: 1) {
            edges {
                node {
                    id
                    price
                    compareAtPrice
                }
            }
        }
        description
        images(first: 5) {
            edges {
                node {
                altText
                originalSrc
                }
            }
            }
      }
    }
  }
  }`,
  variables: {}
  });
  
  let config = {
  method: 'post',
  url: `https://${shop}/admin/api/unstable/graphql.json`,
  headers: { 
    'X-Shopify-Access-Token': token, 
    'Content-Type': 'application/json', 
  },
  data : data
  };
  
  axios.request(config)
  .then((response) => {
  // console.log(JSON.stringify(response.data));
  res.send(response.data)
  })
  .catch((error) => {
  console.log(error);
  });
  })


// Get Funnel

// Get Funnel
// @ts-ignore
app.get("/api/get-funnel", async (req, res) => {
  try {
    const session_data = res.locals.shopify?.session;
    
    if (!session_data) {
      return res.status(401).json({ error: "Unauthorized: No session found" });
    }

    const shop = session_data.shop;

    const getData = `SELECT * FROM funnel WHERE shop = $1`; // ✅ Use parameterized query
    const result = await query(getData, [shop]);

    res.json(result.rows); // ✅ Return rows properly
  } catch (err) {
    console.error("Error retrieving funnel data:", err);
    res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
});

// @ts-ignore
app.put("/api/update-funnel-status/:id", async (req, res) => {
  const funnelId = req.params.id;
  const newStatus = req.body.funnel_status;

  try {
      const result = await query(
          "UPDATE funnel SET funnel_status = $1 WHERE id = $2 RETURNING *",
          [newStatus, funnelId]
      );

      if (result.rowCount === 0) {
          return res.status(404).json({ message: "Funnel not found" });
      }

      res.json({
          funnelId,
          data: result.rows[0],
      });
  } catch (err) {
      console.error("❌ Error updating funnel status:", err);
      res.status(500).json({ message: "Internal Server Error" });
  }
});

// ✅ Insert Funnel Data
// @ts-ignore
app.post('/api/update-funnel', async (req, res) => {
  try {
      const session_data = res.locals.shopify.session;
      const shop_name = session_data?.shop;
      if (!shop_name) {
          return res.status(400).json({ error: 'Shop session is missing' });
      }

      const {
          funnel_name,
          funnel_status,
          funnel_trigger,
          main_product_id,
          accept_product_id,
          decline_product_id,
          accept_status,
          decline_status,
          product_data = {} // Default empty object to avoid errors
      } = req.body;

      // ✅ Insert into `funnel` table
      const sql = `
          INSERT INTO funnel 
              (funnel_name, funnel_status, funnel_trigger, main_product_id, accept_product_id, decline_product_id, accept_status, decline_status, shop)
          VALUES 
              ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;

      const result = await query(sql, [
          funnel_name, funnel_status, funnel_trigger, main_product_id,
          accept_product_id, decline_product_id, accept_status, decline_status, shop_name
      ]);

      // @ts-ignore
      const funnelId = result.rows[0]?.id;
      if (!funnelId) {
          return res.status(500).json({ error: 'Failed to insert funnel data' });
      }

      // ✅ Insert products related to funnel
      const productInserts = [];
      for (const key of ['main_pro_table', 'accept_pro_table', 'decline_pro_table']) {
          if (product_data[key]) {
              const { product_id, image, title, price } = product_data[key];
              productInserts.push([product_id, image, title, price, shop_name]);
          }
      }

      if (productInserts.length > 0) {
          const values = productInserts.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
          const productSql = `INSERT INTO products (product_id, image, title, price, shop) VALUES ${values}`;
          await query(productSql, productInserts.flat());
      }

      res.json({ success: true, funnelId });
  } catch (err) {
      console.error('❌ Error inserting funnel:', err);
      res.status(500).json({ error: 'Failed to insert funnel data' });
  }
});


// @ts-ignore
app.get('/api/editFunnel/:id', async (req, res) => {
  try {
      const funnelId = req.params.id;

      // ✅ Fetch funnel and related products using LEFT JOIN
      const editData = `
          SELECT 
              f.id AS funnel_id,
              f.funnel_name,
              f.main_product_id,
              f.accept_product_id,
              f.decline_product_id,
              f.funnel_status,
              f.funnel_trigger,
              p.product_id, 
              p.image, 
              p.title, 
              p.price, 
              p.shop
          FROM funnel f
          LEFT JOIN products p ON 
              p.product_id IN (f.main_product_id, f.accept_product_id, f.decline_product_id)
          WHERE f.id = $1`;

      const result = await query(editData, [funnelId]);

      if (result.rowCount === 0) {
          return res.status(404).json({ message: 'Funnel not found' });
      }

      res.json({
          funnel_id: funnelId,
          data: result.rows
      });
  } catch (err) {
      console.error('❌ Error retrieving funnel:', err);
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
});

// @ts-ignore
app.put('/api/editFunnel/:id', async (req, res) => {
  try {
      const funnelId = req.params.id;
      const {
          funnel_name,
          funnel_status,
          funnel_trigger,
          main_product_id,
          accept_product_id,
          decline_product_id,
          accept_status,
          decline_status
      } = req.body;

      // ✅ Validate required fields
      if (!funnel_name || !funnel_status || !funnel_trigger || !main_product_id) {
          return res.status(400).json({ error: 'Missing required fields' });
      }

      // ✅ Update funnel data
      const funnelSql = `
          UPDATE funnel SET
              funnel_name = $1,
              funnel_status = $2,
              funnel_trigger = $3,
              main_product_id = $4,
              accept_product_id = $5,
              decline_product_id = $6,
              accept_status = $7,
              decline_status = $8
          WHERE Id = $9 RETURNING *`;

      const result = await query(funnelSql, [
          funnel_name, funnel_status, funnel_trigger, main_product_id,
          accept_product_id, decline_product_id, accept_status, decline_status, funnelId
      ]);

      if (result.rowCount === 0) {
          return res.status(404).json({ message: 'Funnel not found' });
      }

      res.json({ message: 'Funnel updated successfully', data: result.rows[0] });
  } catch (err) {
      console.error('❌ Error updating funnel:', err);
      res.status(500).json({ error: 'Failed to update funnel data', details: err.message });
  }
});

// @ts-ignore
app.delete('/api/delete-funnel/:id', async (req, res) => {
  const proId = req.params.id;

  try {
    // 🔹 Step 1: Check if the funnel exists before attempting deletion
    const checkResult = await query('SELECT * FROM funnel WHERE id = $1', [proId]);

    if (checkResult.rowCount === 0) {
      return res.status(404).json({ message: 'Funnel not found' });
    }

    // 🔹 Step 2: Delete the funnel
    await query('DELETE FROM funnel WHERE id = $1', [proId]);

    res.json({ message: 'Funnel deleted successfully', proId });
  } catch (err) {
    console.error('Error deleting funnel:', err);
    res.status(500).json({ error: 'Failed to delete funnel data' });
  }
});

  




// Product Count
app.get("/api/products/count", async (_req, res) => {
  // console.log("rtttt",res.locals.shopify.session);
  const countData = await shopify.api.rest.Product.count({
    session: res.locals.shopify.session,
  });
  res.status(200).send(countData);
});

app.get("/api/products/create", async (_req, res) => {
  let status = 200;
  let error = null;

  try {
    await productCreator(res.locals.shopify.session);
  } catch (e) {
    // console.log(`Failed to process products/create: ${e.message}`);
    status = 500;
    error = e.message;
  }
  res.status(status).send({ success: status === 200, error });
});

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

// @ts-ignore
app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(join(STATIC_PATH, "index.html")));
});

app.listen(PORT);
