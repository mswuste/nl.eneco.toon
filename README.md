###Toon by Eneco app for Homey

Let Homey control your Toon®!

Set the target temperature, read the room temperature and display your electricity and gas usage in Insights!

BETA: The app is currently released as beta due to minor instabilities on the Toon API and serves as a test. Please inform us of any bugs or instabilities.

DISCLAIMER: This application uses the Toon® API but has not been developed, certified or otherwise approved on behalf of or on the instructions of Toon.

###Changelog

- 1.0.14: Removed usage of "state": 1 parameter value in /temperature/states API call, this parameter should enforce the program to resume after the state change has expired, however it appears to cause instability which prevents users from changing the state at all.