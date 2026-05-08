import ee
import geemap

# Initialize Earth Engine
ee.Initialize()

# 🔥 Load India districts dataset
# FAO GAUL dataset (best for district level)
districts = ee.FeatureCollection("FAO/GAUL/2015/level2")

# 🔍 Filter for Gurdaspur
gurdaspur = districts.filter(
    ee.Filter.And(
        ee.Filter.eq("ADM0_NAME", "India"),
        ee.Filter.eq("ADM1_NAME", "Punjab"),
        ee.Filter.eq("ADM2_NAME", "Gurdaspur")
    )
)

# ✅ Check if data exists
count = gurdaspur.size().getInfo()
print(f"Features found: {count}")

# ❌ If 0 aaye to name mismatch hai
# Alternative names try karo:
# "Gurdaspur District", "Gurdaspur"

# 🔥 Export to GeoJSON
out_file = "gurdaspur_boundary.geojson"

geemap.ee_export_vector(gurdaspur, filename=out_file)

print(f"✅ Boundary exported to {out_file}")