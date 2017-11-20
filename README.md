###Toon by Eneco app for Homey

Let Homey control your Toon®!

Set the target temperature, read the room temperature and display your electricity and gas usage in Insights!

DISCLAIMER: This application uses the Toon® API but has not been developed, certified or otherwise approved on behalf of or on the instructions of Toon.

###Changelog
- 1.3.3: Fix Flow tokens for gas and electricity Flow cards.
- 1.3.2: Add gas and electricity readings as displayed on Toon itself (current power usage, cumulative power usage per day, cumulative gas usage per day). Note: for these readings to show up in the mobile app Toon needs to be re-paired to Homey.
- 1.2.3: Immediately update target temperature when temperature state changed via Homey. 
- 1.2.2: Update for SDKv2, and fix connection issues.
- 1.1.0: Added disable/enable program Flow cards, added resume/don't resume program option on state change Flow card, changing a state from Mobile will now not override the program.
- 1.0.14: Removed usage of "state": 1 parameter value in /temperature/states API call, this parameter should enforce the program to resume after the state change has expired, however it appears to cause instability which prevents users from changing the state at all.